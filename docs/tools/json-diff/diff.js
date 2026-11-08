/* Compare two JSON documents (usually two API responses): pure functions, no DOM.
   Runs in the browser (window.JsonDiff), in a Web Worker (the page posts { id, a, b, opts } to this same file)
   and in Node (module.exports) for unit tests.

   diff(before, after, opts) walks both values once and returns
     { diffs: [{ kind, path, lp, rp, ra?, before, after, beforeType, afterType, len? }],
       counts: { added, removed, changed, type }, total, ignored, truncated, ignoredPaths }
   kind is 'added' | 'removed' | 'changed' | 'type'. Paths look like $.items[2].price or $["x-trace-id"].
   lp / rp are the paths in the before / after document (they differ when array order is ignored).

   Options:
     ignoreKeys        'id, *.timestamp, $.meta.requestId, $.items[*].sku, created*'  (string or array)
     ignoreOrder       compare arrays as multisets
     matchKey          with ignoreOrder: pair objects in arrays by this field (e.g. 'id')
     tolerance         numbers within this absolute difference are equal (e.g. 0.01)
     nullEqualsMissing a key set to null on one side and absent on the other is not a difference
     maxDiffs          stop storing differences after this many (counts keep going)
*/
(function (root) {
  'use strict';

  const hasOwn = Object.prototype.hasOwnProperty;
  const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

  function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
  }
  const keySeg = k => (IDENT.test(k) ? '.' + k : '[' + JSON.stringify(k) + ']');

  // ---------------------------------------------------------------- parsing with useful errors

  function cleanText(text) {
    return String(text == null ? '' : text).replace(/^﻿/, '');
  }

  // Strict JSON scanner, only used after JSON.parse fails, to find where and why.
  // Browsers word (and place) JSON.parse errors differently; this gives the same message everywhere.
  function locateError(s) {
    let i = 0;
    const n = s.length;
    const fail = msg => { const e = new Error(msg); e.pos = i; throw e; };
    const ws = () => {
      while (i < n) { const c = s.charCodeAt(i); if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break; }
    };
    const NUM = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    function str() {
      i++;
      for (;;) {
        if (i >= n) fail('a string is not closed (missing ")');
        const c = s.charCodeAt(i);
        if (c === 34) { i++; return; }
        if (c === 92) {
          const e = s[i + 1];
          if (e === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(s.substr(i + 2, 4))) { i++; fail('\\u must be followed by 4 hex digits'); } i += 6; continue; }
          if (e === undefined || '"\\/bfnrt'.indexOf(e) < 0) { i++; fail('invalid escape \\' + (e || '') + ' in a string'); }
          i += 2; continue;
        }
        if (c < 32) fail(c === 10 ? 'a string runs over a line break (line breaks inside strings must be written as \\n)' : 'a control character (such as a tab) inside a string must be escaped');
        i++;
      }
    }
    function word() { const m = /^[A-Za-z_]+/.exec(s.slice(i, i + 20)); return m ? m[0] : ''; }
    function value(depth) {
      if (depth > 5000) fail('the JSON is nested too deeply');
      ws();
      if (i >= n) fail('the input ends where a value was expected');
      const c = s[i];
      if (c === '{') {
        i++; ws();
        if (s[i] === '}') { i++; return; }
        for (;;) {
          ws();
          if (s[i] !== '"') {
            if (i >= n) fail('the input ends inside an object (missing })');
            if (s[i] === "'") fail('keys need double quotes, not single quotes');
            if (s[i] === '}') fail('trailing comma before }');
            if (/[A-Za-z_$]/.test(s[i])) fail('keys need double quotes, e.g. "' + word() + '"');
            fail('expected a key in double quotes');
          }
          str(); ws();
          if (s[i] !== ':') fail(i >= n ? 'the input ends after a key' : "expected ':' after the key");
          i++;
          value(depth + 1); ws();
          if (s[i] === ',') { i++; continue; }
          if (s[i] === '}') { i++; return; }
          fail(i >= n ? 'the input ends inside an object (missing })' : "expected ',' or '}' after a value");
        }
      }
      if (c === '[') {
        i++; ws();
        if (s[i] === ']') { i++; return; }
        for (;;) {
          ws();
          if (s[i] === ']') fail('trailing comma before ]');
          value(depth + 1); ws();
          if (s[i] === ',') { i++; continue; }
          if (s[i] === ']') { i++; return; }
          fail(i >= n ? 'the input ends inside an array (missing ])' : "expected ',' or ']' after a value");
        }
      }
      if (c === '"') return str();
      if (c === "'") fail('strings need double quotes, not single quotes');
      if (c === '-' || (c >= '0' && c <= '9')) {
        NUM.lastIndex = i;
        const m = NUM.exec(s);
        if (!m || !m[0] || m[0] === '-') fail('invalid number');
        i += m[0].length;
        if (/[0-9.eE]/.test(s[i] || '')) fail('invalid number (no leading zeros, and a digit is needed after the decimal point)');
        return;
      }
      if (s.startsWith('true', i)) { i += 4; return; }
      if (s.startsWith('false', i)) { i += 5; return; }
      if (s.startsWith('null', i)) { i += 4; return; }
      const w = word();
      if (w === 'NaN' || w === 'Infinity' || w === 'undefined') fail(w + " isn't valid in JSON");
      if (w === 'True' || w === 'False' || w === 'None') fail(w + ' is Python, not JSON (use ' + { True: 'true', False: 'false', None: 'null' }[w] + ')');
      if (c === '/') fail("comments aren't allowed in JSON");
      if (c === ' ') fail('a non-breaking space (often copied from a web page or chat)');
      if (c === '+') fail("numbers can't start with +");
      if (c === '.') fail('numbers need a digit before the decimal point');
      fail('unexpected character ' + JSON.stringify(c));
    }
    ws();
    if (i >= n) fail('it is empty');
    value(0); ws();
    if (i < n) fail(s[i] === ',' ? 'there is a comma after the end of the JSON value' : 'there is more content after the end of the JSON value');
    return null;
  }

  function lineCol(s, pos) {
    let line = 1, start = 0;
    for (let k = s.indexOf('\n'); k !== -1 && k < pos; k = s.indexOf('\n', k + 1)) { line++; start = k + 1; }
    let end = s.indexOf('\n', start); if (end < 0) end = s.length;
    const col = pos - start + 1;
    // excerpt of at most ~70 characters around the column
    const from = Math.max(start, pos - 40), to = Math.min(end, from + 70);
    const excerpt = s.slice(from, to).replace(/\t/g, ' ').replace(/\r/g, '');
    return { line, col, excerpt: (from > start ? '…' : '') + excerpt + (to < end ? '…' : ''), caret: pos - from + (from > start ? 1 : 0) };
  }

  // parse(text, label) -> value, or throws Error with .line, .col, .excerpt, .caret, .label
  function parse(text, label) {
    const s = cleanText(text);
    label = label || 'JSON';
    if (!s.trim()) { const e = new Error(label + ' is empty. Paste a JSON document.'); e.label = label; e.empty = true; throw e; }
    try { return JSON.parse(s); } catch (native) {
      let where = null, why = '';
      try { locateError(s); } catch (e) { if (e && typeof e.pos === 'number') { where = lineCol(s, e.pos); why = e.message; } }
      if (!where) { // scanner found nothing: fall back to the browser's message and any position in it
        const m = /position (\d+)/.exec(native.message);
        if (m) where = lineCol(s, +m[1]);
        why = native.message;
      }
      const err = new Error(label + ' is not valid JSON' + (where ? ': line ' + where.line + ', column ' + where.col : '') + ': ' + why + '.');
      err.label = label; err.reason = why;
      if (where) Object.assign(err, where);
      throw err;
    }
  }

  // ---------------------------------------------------------------- ignore patterns

  // Pattern forms: key | key.child | *.key | created* | $.meta.requestId | $.items[*].id | $..id | **.id
  function splitPattern(p) {
    const segs = [];
    let i = 0;
    while (i < p.length) {
      const c = p[i];
      if (c === '.') {
        if (p[i + 1] === '.') { segs.push({ deep: true }); i += 2; continue; }
        i++; continue;
      }
      if (c === '[') {
        const j = p.indexOf(']', i);
        const inner = (j < 0 ? p.slice(i + 1) : p.slice(i + 1, j)).trim();
        i = j < 0 ? p.length : j + 1;
        if (inner === '*') segs.push({ anyIndex: true });
        else if (/^\d+$/.test(inner)) segs.push({ index: +inner });
        else if (/^(['"]).*\1$/.test(inner)) segs.push({ key: inner.slice(1, -1) });
        else segs.push(globSeg(inner));
        continue;
      }
      let j = i;
      while (j < p.length && p[j] !== '.' && p[j] !== '[') j++;
      segs.push(globSeg(p.slice(i, j)));
      i = j;
    }
    return segs;
  }
  function globSeg(s) {
    if (s === '**') return { deep: true };
    if (s === '*') return { any: true };
    if (s.indexOf('*') >= 0) return { re: new RegExp('^' + s.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$') };
    return { key: s };
  }

  function compileIgnore(spec) {
    const list = (Array.isArray(spec) ? spec : String(spec || '').split(/[,\n]/)).map(s => String(s).trim()).filter(Boolean);
    const out = [];
    for (const src of list) {
      let s = src, anchored = false;
      if (s[0] === '$') { anchored = true; s = s.slice(1); }
      const segs = splitPattern(s);
      if (!anchored) { while (segs.length && segs[0].deep) segs.shift(); if (segs.length && segs[0].any && segs.length > 1) segs.shift(); segs.unshift({ deep: true }); }
      if (segs.length === 0 || (segs.length === 1 && segs[0].deep)) continue;
      out.push({ src, segs, last: segs[segs.length - 1] });
    }
    return out;
  }

  function segOk(m, v) {
    if (m.any) return true;
    if (typeof v === 'number') return m.anyIndex === true || m.index === v;
    if (m.key !== undefined) return m.key === v;
    if (m.re) return m.re.test(v);
    return false;
  }
  function matchFrom(segs, si, path, pi) {
    for (;;) {
      if (si === segs.length) return pi === path.length;
      const m = segs[si];
      if (m.deep) {
        for (let k = pi; k <= path.length; k++) if (matchFrom(segs, si + 1, path, k)) return true;
        return false;
      }
      if (pi === path.length || !segOk(m, path[pi])) return false;
      si++; pi++;
    }
  }
  function ignoredBy(pats, path) {
    if (!path.length) return false;
    const leaf = path[path.length - 1];
    for (const p of pats) {
      if (!p.last.deep && !segOk(p.last, leaf)) continue; // fast reject on the last segment
      if (matchFrom(p.segs, 0, path, 0)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- diff

  const DEFAULTS = { ignoreKeys: '', ignoreOrder: false, matchKey: '', tolerance: 0, nullEqualsMissing: false, maxDiffs: 100000 };

  function normOpts(o) {
    const r = Object.assign({}, DEFAULTS, o || {});
    r.tolerance = Math.max(0, +r.tolerance || 0);
    r.matchKey = String(r.matchKey || '').trim();
    r.maxDiffs = Math.max(1, +r.maxDiffs || DEFAULTS.maxDiffs);
    return r;
  }

  function diff(a, b, opts) {
    const o = normOpts(opts);
    const pats = compileIgnore(o.ignoreKeys);
    const ign = pats.length > 0;
    const tol = o.tolerance, nullEq = !!o.nullEqualsMissing, unordered = !!o.ignoreOrder, mk = o.matchKey;
    const out = [];
    const counts = { added: 0, removed: 0, changed: 0, type: 0 };
    const ignoredPaths = { left: [], right: [] };
    let ignored = 0, truncated = false;
    const ls = [], rs = []; // path segments (keys and indices) on each side

    function push(d) {
      counts[d.kind]++;
      if (out.length < o.maxDiffs) out.push(d); else truncated = true;
    }
    function skip(lp, rp) {
      ignored++;
      if (lp != null && ignoredPaths.left.length < 5000) ignoredPaths.left.push(lp);
      if (rp != null && ignoredPaths.right.length < 5000) ignoredPaths.right.push(rp);
    }
    const isIgn = () => ign && (ignoredBy(pats, ls) || ignoredBy(pats, rs));
    const numEq = (x, y) => x === y || Math.abs(x - y) <= tol + 1e-12 * Math.max(Math.abs(x), Math.abs(y));

    // canonical form used to match array elements regardless of order; honours every option except tolerance
    function canon(v, segs) {
      switch (typeOf(v)) {
        case 'null': return 'n';
        case 'boolean': return v ? 't' : 'f';
        case 'number': return '#' + v;
        case 'string': return JSON.stringify(v);
        case 'array': {
          const parts = new Array(v.length);
          for (let i = 0; i < v.length; i++) { segs.push(i); parts[i] = ign && ignoredBy(pats, segs) ? '~' : canon(v[i], segs); segs.pop(); }
          if (unordered) parts.sort();
          return '[' + parts.join(',') + ']';
        }
        default: {
          const keys = Object.keys(v).sort();
          let s = '{';
          for (const k of keys) {
            const x = v[k];
            if (nullEq && x === null) continue;
            segs.push(k);
            if (!(ign && ignoredBy(pats, segs))) s += JSON.stringify(k) + ':' + canon(x, segs) + ',';
            segs.pop();
          }
          return s + '}';
        }
      }
    }

    function walk(x, y, lp, rp, ra) {
      if (x === y) return;
      const tx = typeOf(x), ty = typeOf(y);
      if (tx !== ty) {
        push({ kind: 'type', path: rp, lp, rp, ra, before: x, after: y, beforeType: tx, afterType: ty });
        return;
      }
      if (tx === 'number') {
        if (!numEq(x, y)) push({ kind: 'changed', path: rp, lp, rp, ra, before: x, after: y, beforeType: tx, afterType: ty });
        return;
      }
      if (tx === 'string' || tx === 'boolean') {
        push({ kind: 'changed', path: rp, lp, rp, ra, before: x, after: y, beforeType: tx, afterType: ty });
        return;
      }
      if (tx === 'object') return walkObject(x, y, lp, rp, ra);
      return unordered ? walkUnordered(x, y, lp, rp, ra) : walkArray(x, y, lp, rp, ra);
    }

    function walkObject(x, y, lp, rp, ra) {
      for (const k in x) {
        if (!hasOwn.call(x, k)) continue;
        const seg = keySeg(k);
        const l2 = lp + seg, r2 = rp + seg, a2 = ra === undefined ? undefined : ra + seg;
        ls.push(k); rs.push(k);
        if (hasOwn.call(y, k)) {
          if (isIgn()) skip(l2, r2); else walk(x[k], y[k], l2, r2, a2);
        } else if (isIgn()) skip(l2, null);
        else if (!(nullEq && x[k] === null)) push({ kind: 'removed', path: l2, lp: l2, rp: r2, ra: a2, before: x[k], beforeType: typeOf(x[k]) });
        ls.pop(); rs.pop();
      }
      for (const k in y) {
        if (!hasOwn.call(y, k) || hasOwn.call(x, k)) continue;
        const seg = keySeg(k);
        const l2 = lp + seg, r2 = rp + seg, a2 = ra === undefined ? undefined : ra + seg;
        ls.push(k); rs.push(k);
        if (isIgn()) skip(null, r2);
        else if (!(nullEq && y[k] === null)) push({ kind: 'added', path: r2, lp: l2, rp: r2, ra: a2, after: y[k], afterType: typeOf(y[k]) });
        ls.pop(); rs.pop();
      }
    }

    function walkArray(x, y, lp, rp, ra) {
      const n = Math.min(x.length, y.length);
      for (let i = 0; i < n; i++) {
        const seg = '[' + i + ']';
        ls.push(i); rs.push(i);
        if (isIgn()) skip(lp + seg, rp + seg);
        else walk(x[i], y[i], lp + seg, rp + seg, ra === undefined ? undefined : ra + seg);
        ls.pop(); rs.pop();
      }
      for (let i = n; i < x.length; i++) {
        const seg = '[' + i + ']';
        ls.push(i);
        if (ign && ignoredBy(pats, ls)) skip(lp + seg, null);
        else push({ kind: 'removed', path: lp + seg, lp: lp + seg, rp: rp + seg, ra: ra === undefined ? undefined : ra + seg, before: x[i], beforeType: typeOf(x[i]), len: y.length, arr: rp, arrA: ra });
        ls.pop();
      }
      for (let i = n; i < y.length; i++) {
        const seg = '[' + i + ']';
        rs.push(i);
        if (ign && ignoredBy(pats, rs)) skip(null, rp + seg);
        else push({ kind: 'added', path: rp + seg, lp: lp + seg, rp: rp + seg, ra: ra === undefined ? undefined : ra + seg, after: y[i], afterType: typeOf(y[i]), len: y.length, arr: rp, arrA: ra });
        rs.pop();
      }
    }

    function walkUnordered(x, y, lp, rp, ra) {
      const usedY = new Uint8Array(y.length);
      const leftX = [];
      const pairs = []; // [i, j, accessor]
      let xi = [];
      for (let i = 0; i < x.length; i++) {
        ls.push(i);
        if (ign && ignoredBy(pats, ls)) skip(lp + '[' + i + ']', null); else xi.push(i);
        ls.pop();
      }
      let yj = [];
      for (let j = 0; j < y.length; j++) {
        rs.push(j);
        if (ign && ignoredBy(pats, rs)) { skip(null, rp + '[' + j + ']'); usedY[j] = 1; } else yj.push(j);
        rs.pop();
      }
      // 1. pair objects by the match key
      if (mk) {
        const keyOf = v => (v && typeof v === 'object' && !Array.isArray(v) && hasOwn.call(v, mk) && (v[mk] === null || typeof v[mk] !== 'object') ? typeOf(v[mk]) + ':' + String(v[mk]) : null);
        const byKey = new Map();
        for (const j of yj) { const k = keyOf(y[j]); if (k !== null) { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(j); } }
        if (byKey.size) {
          const rest = [];
          for (const i of xi) {
            const k = keyOf(x[i]), list = k !== null && byKey.get(k);
            if (list && list.length) {
              const j = list.shift(); usedY[j] = 1;
              const lit = x[i][mk];
              const acc = (ra === undefined ? rp : ra) + '.find((x) => x' + keySeg(mk) + ' === ' + JSON.stringify(lit) + ')';
              pairs.push([i, j, acc]);
            } else rest.push(i);
          }
          xi = rest; yj = yj.filter(j => !usedY[j]);
        }
      }
      // 2. exact matches (under the options) by canonical form
      if (xi.length && yj.length) {
        const byCanon = new Map();
        for (const j of yj) { rs.push(j); const c = canon(y[j], rs); rs.pop(); if (!byCanon.has(c)) byCanon.set(c, []); byCanon.get(c).push(j); }
        for (const i of xi) {
          ls.push(i); const c = canon(x[i], ls); ls.pop();
          const list = byCanon.get(c);
          if (list && list.length) usedY[list.shift()] = 1; else leftX.push(i);
        }
        yj = yj.filter(j => !usedY[j]);
      } else leftX.push(...xi);
      // 3. leftovers: numbers within tolerance pair up; containers of the same kind pair in order; the rest are added/removed
      // (sorted two-pointer pass for numbers and per-type queues for containers, so this stays O(n log n))
      const usedL = new Uint8Array(y.length);
      const xNum = [], yNum = [], qY = { object: [], array: [] };
      for (const j of yj) { const t = typeOf(y[j]); if (t === 'number') yNum.push(j); else if (qY[t]) qY[t].push(j); }
      const remX = [];
      const qPos = { object: 0, array: 0 };
      for (const i of leftX) {
        const t = typeOf(x[i]);
        if (t === 'number') xNum.push(i);
        else if (qY[t] && qPos[t] < qY[t].length) { const j = qY[t][qPos[t]++]; usedL[j] = 1; pairs.push([i, j, undefined]); }
        else remX.push(i);
      }
      if (xNum.length && yNum.length && tol > 0) {
        xNum.sort((p, q) => x[p] - x[q]); yNum.sort((p, q) => y[p] - y[q]);
        let p = 0, q = 0;
        while (p < xNum.length && q < yNum.length) {
          const xv = x[xNum[p]], yv = y[yNum[q]];
          if (numEq(xv, yv)) { usedL[yNum[q]] = 1; p++; q++; }
          else if (xv < yv) remX.push(xNum[p++]);
          else q++;
        }
        while (p < xNum.length) remX.push(xNum[p++]);
      } else remX.push(...xNum);
      remX.sort((p, q) => p - q);
      const leftY = yj.filter(j => !usedL[j]);
      for (const [i, j, acc] of pairs) {
        ls.push(i); rs.push(j);
        const r2 = rp + '[' + j + ']';
        walk(x[i], y[j], lp + '[' + i + ']', r2, acc !== undefined ? acc : ra === undefined ? undefined : ra + '[' + j + ']');
        ls.pop(); rs.pop();
      }
      for (const i of remX) push({ kind: 'removed', path: lp + '[' + i + ']', lp: lp + '[' + i + ']', rp: null, before: x[i], beforeType: typeOf(x[i]), len: y.length, arr: rp, arrA: ra, unordered: true });
      for (const j of leftY) push({ kind: 'added', path: rp + '[' + j + ']', lp: null, rp: rp + '[' + j + ']', after: y[j], afterType: typeOf(y[j]), len: y.length, arr: rp, arrA: ra, unordered: true });
    }

    walk(a, b, '$', '$', undefined);
    const total = counts.added + counts.removed + counts.changed + counts.type;
    return { diffs: out, counts, total, ignored, truncated, ignoredPaths, options: o };
  }

  // ---------------------------------------------------------------- previews and formatting

  // JSON text of v, cut off at max characters without stringifying the whole value
  function preview(v, max) {
    max = max || 120;
    if (v === undefined) return '(missing)';
    const t = typeOf(v);
    if (t !== 'object' && t !== 'array') { const s = JSON.stringify(v); return s.length > max ? s.slice(0, max - 1) + '…' : s; }
    let s = '';
    const STOP = {};
    const add = x => { s += x; if (s.length > max) throw STOP; };
    function go(x) {
      const tx = typeOf(x);
      if (tx === 'array') { add('['); for (let i = 0; i < x.length; i++) { if (i) add(', '); go(x[i]); } add(']'); }
      else if (tx === 'object') { add('{'); let f = true; for (const k in x) { if (!hasOwn.call(x, k)) continue; if (!f) add(', '); f = false; add(JSON.stringify(k) + ': '); go(x[k]); } add('}'); }
      else add(JSON.stringify(x));
    }
    try { go(v); return s; } catch (e) { if (e !== STOP) throw e; return s.slice(0, max - 1) + '…'; }
  }

  const KIND_LABEL = { added: 'Added', removed: 'Removed', changed: 'Changed', type: 'Type change' };

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many || one + 's'); }

  function headline(res) {
    if (!res.total) return 'No differences';
    const c = res.counts, parts = [];
    if (c.changed) parts.push(c.changed + ' changed');
    if (c.type) parts.push(plural(c.type, 'type change'));
    if (c.added) parts.push(c.added + ' added');
    if (c.removed) parts.push(c.removed + ' removed');
    return plural(res.total, 'difference') + ': ' + parts.join(', ');
  }

  function describeOptions(o) {
    const p = [];
    const keys = compileIgnore(o.ignoreKeys).map(x => x.src);
    if (keys.length) p.push('ignore ' + keys.join(', '));
    if (o.ignoreOrder) p.push('ignore array order' + (o.matchKey ? ' (objects matched by ' + o.matchKey + ')' : ''));
    if (o.tolerance) p.push('numeric tolerance ' + o.tolerance);
    if (o.nullEqualsMissing) p.push('null = missing');
    return p.length ? p.join('; ') : 'strict comparison';
  }

  function mdCode(s) {
    s = String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    return s.indexOf('`') >= 0 ? '`` ' + s + ' ``' : '`' + s + '`';
  }

  function toMarkdown(res, limit) {
    limit = limit || 1000;
    const o = [];
    o.push('**JSON diff: ' + headline(res) + '**' + (res.ignored ? ' (' + plural(res.ignored, 'field') + ' ignored)' : ''));
    o.push('');
    if (res.total) {
      o.push('| Change | Path | Before | After |');
      o.push('|---|---|---|---|');
      const rows = res.diffs.slice(0, limit);
      for (const d of rows) {
        const before = d.kind === 'added' ? '(missing)' : preview(d.before, 80) + (d.kind === 'type' ? ' (' + d.beforeType + ')' : '');
        const after = d.kind === 'removed' ? '(missing)' : preview(d.after, 80) + (d.kind === 'type' ? ' (' + d.afterType + ')' : '');
        o.push('| ' + KIND_LABEL[d.kind] + ' | ' + mdCode(d.path) + ' | ' + mdCode(before) + ' | ' + mdCode(after) + ' |');
      }
      if (res.total > rows.length) o.push('', '_' + (res.total - rows.length) + ' more differences not listed._');
      o.push('');
    }
    o.push('_Options: ' + describeOptions(res.options) + '. Compared at pawansinha.com.au/tools/json-diff/_');
    return o.join('\n');
  }

  function toJSON(res) {
    return JSON.stringify({
      summary: Object.assign({ total: res.total, ignored: res.ignored }, res.counts),
      options: { ignoreKeys: compileIgnore(res.options.ignoreKeys).map(x => x.src), ignoreOrder: res.options.ignoreOrder,
        matchKey: res.options.matchKey || null, tolerance: res.options.tolerance, nullEqualsMissing: res.options.nullEqualsMissing },
      truncated: res.truncated,
      differences: res.diffs.map(d => {
        const r = { change: d.kind, path: d.path };
        if (d.lp && d.rp && d.lp !== d.rp) { r.beforePath = d.lp; r.afterPath = d.rp; }
        if (d.kind !== 'added') { r.before = d.before; r.beforeType = d.beforeType; }
        if (d.kind !== 'removed') { r.after = d.after; r.afterType = d.afterType; }
        return r;
      }),
    }, null, 2);
  }

  // ---------------------------------------------------------------- assertions

  // JS accessor for a path in the "after" document: $.items[2]["x-id"] -> body.items[2]["x-id"]
  const accessor = (d, v) => v + (d.ra !== undefined && d.ra !== null ? d.ra : d.rp).slice(1);
  const arrAccessor = (d, v) => v + (d.arrA !== undefined && d.arrA !== null ? d.arrA : d.arr).slice(1);

  function assertions(res, opts) {
    opts = opts || {};
    const max = opts.max || 100;
    const tol = res.options.tolerance;
    const pw = [], k6 = [];
    const doneArr = new Set();
    let n = 0, skipped = 0;
    for (const d of res.diffs) {
      if (n >= max) { skipped++; continue; }
      const nameLit = s => JSON.stringify(s.length > 70 ? s.slice(0, 69) + '…' : s);
      // added or removed array elements: assert the new length once per array
      if (d.len !== undefined && d.arr) {
        const mk = res.options.matchKey, v = d.after;
        if (d.kind === 'added' && mk && typeOf(v) === 'object' && hasOwn.call(v, mk) && typeOf(v[mk]) !== 'object' && typeOf(v[mk]) !== 'array') {
          const lit = JSON.stringify(v), find = `.find((x) => x${keySeg(mk)} === ${JSON.stringify(v[mk])})`;
          if (lit.length <= 200) {
            pw.push(`expect(${arrAccessor(d, 'body')}${find}).toEqual(${lit});`);
            k6.push(`  ${nameLit(d.arr + ' has ' + mk + ' ' + JSON.stringify(v[mk]))}: (b) => JSON.stringify(${arrAccessor(d, 'b')}${find}) === ${JSON.stringify(lit)},`);
          } else {
            pw.push(`expect(${arrAccessor(d, 'body')}${find}).toBeDefined();`);
            k6.push(`  ${nameLit(d.arr + ' has ' + mk + ' ' + JSON.stringify(v[mk]))}: (b) => ${arrAccessor(d, 'b')}${find} !== undefined,`);
          }
          n++;
        }
        if (doneArr.has(d.arr)) continue;
        doneArr.add(d.arr);
        pw.push(`expect(${arrAccessor(d, 'body')}).toHaveLength(${d.len});`);
        k6.push(`  ${nameLit(d.arr + ' has ' + d.len + ' items')}: (b) => ${arrAccessor(d, 'b')}.length === ${d.len},`);
        n++; continue;
      }
      if (d.kind === 'removed') {
        pw.push(`expect(${accessor(d, 'body')}).toBeUndefined();`);
        k6.push(`  ${nameLit(d.path + ' is gone')}: (b) => ${accessor(d, 'b')} === undefined,`);
        n++; continue;
      }
      const v = d.after, t = typeOf(v), pa = accessor(d, 'body'), ka = accessor(d, 'b');
      if (t === 'number' && tol > 0) {
        pw.push(`expect(Math.abs(${pa} - ${v})).toBeLessThanOrEqual(${tol});`);
        k6.push(`  ${nameLit(d.path + ' ≈ ' + v)}: (b) => Math.abs(${ka} - ${v}) <= ${tol},`);
      } else if (t !== 'object' && t !== 'array') {
        const lit = JSON.stringify(v);
        pw.push(`expect(${pa}).toBe(${lit});`);
        k6.push(`  ${nameLit(d.path + ' is ' + lit)}: (b) => ${ka} === ${lit},`);
      } else {
        const lit = JSON.stringify(v);
        if (lit.length <= 200) {
          pw.push(`expect(${pa}).toEqual(${lit});`);
          k6.push(`  ${nameLit(d.path + ' matches')}: (b) => JSON.stringify(${ka}) === ${JSON.stringify(lit)},`);
        } else if (t === 'array') {
          pw.push(`expect(${pa}).toHaveLength(${v.length});`);
          k6.push(`  ${nameLit(d.path + ' has ' + v.length + ' items')}: (b) => Array.isArray(${ka}) && ${ka}.length === ${v.length},`);
        } else {
          const keys = JSON.stringify(Object.keys(v).sort());
          pw.push(`expect(Object.keys(${pa}).sort()).toEqual(${keys});`);
          k6.push(`  ${nameLit(d.path + ' has the expected keys')}: (b) => JSON.stringify(Object.keys(${ka} || {}).sort()) === ${JSON.stringify(keys)},`);
        }
      }
      n++;
    }
    const more = skipped ? `// ${skipped} more differences not asserted. Filter the table or raise the limit.\n` : '';
    if (!n) {
      const none = '// No differences, so nothing to assert.\n';
      return { playwright: none, k6: none, count: 0 };
    }
    const playwright = `// Playwright: assert the "after" values of ${plural(n, 'difference')}.\n` +
      `// const response = await request.get('/your/endpoint');\n` +
      `const body = await response.json();\n` + pw.join('\n') + '\n' + more;
    const k6s = `import { check } from 'k6';\n\n// Inside your default function, after: const res = http.get('https://…/your/endpoint');\n` +
      `const body = res.json();\ncheck(body, {\n` + k6.join('\n') + '\n});\n' + more;
    return { playwright, k6: k6s, count: n };
  }

  // ---------------------------------------------------------------- side-by-side pretty view

  // Pretty-print v (2-space indent) into lines, recording the line span of each wanted path.
  function prettyLines(v, wanted) {
    const lines = [];
    const spans = new Map();
    const pad = d => '  '.repeat(d);
    function isEmptyObj(o) { for (const k in o) if (hasOwn.call(o, k)) return false; return true; }
    function emit(x, path, prefix, depth, last) {
      const start = lines.length;
      const t = typeOf(x), comma = last ? '' : ',';
      if (t === 'array' && x.length) {
        lines.push(pad(depth) + prefix + '[');
        for (let i = 0; i < x.length; i++) emit(x[i], path + '[' + i + ']', '', depth + 1, i === x.length - 1);
        lines.push(pad(depth) + ']' + comma);
      } else if (t === 'object' && !isEmptyObj(x)) {
        lines.push(pad(depth) + prefix + '{');
        const keys = Object.keys(x);
        for (let i = 0; i < keys.length; i++) emit(x[keys[i]], path + keySeg(keys[i]), JSON.stringify(keys[i]) + ': ', depth + 1, i === keys.length - 1);
        lines.push(pad(depth) + '}' + comma);
      } else {
        lines.push(pad(depth) + prefix + (t === 'array' ? '[]' : t === 'object' ? '{}' : JSON.stringify(x)) + comma);
      }
      if (wanted.has(path)) spans.set(path, [start, lines.length - 1]);
    }
    emit(v, '$', '', 0, true);
    return { lines, spans };
  }

  const MARK = { del: 1, add: 2, chg: 3, ign: 4 };
  const MARK_CLASS = ['', 'del', 'add', 'chg', 'ign'];

  // Build both panes: full (first maxLines lines) and context (only lines near differences).
  function sideBySide(a, b, res, opts) {
    opts = opts || {};
    const ctx = opts.context == null ? 3 : opts.context, maxLines = opts.maxLines || 3000, maxChars = opts.maxChars || 300;
    const wantL = new Set(res.ignoredPaths.left), wantR = new Set(res.ignoredPaths.right);
    for (const d of res.diffs) {
      if (d.kind !== 'added' && d.lp) wantL.add(d.lp);
      if (d.kind !== 'removed' && d.rp) wantR.add(d.rp);
    }
    const L = prettyLines(a, wantL), R = prettyLines(b, wantR);
    const mL = new Uint8Array(L.lines.length), mR = new Uint8Array(R.lines.length);
    const mark = (m, spans, path, code) => {
      const sp = path && spans.get(path);
      if (!sp) return;
      for (let k = sp[0]; k <= sp[1]; k++) if (m[k] === 0 || m[k] === MARK.ign) m[k] = code;
    };
    for (const p of res.ignoredPaths.left) mark(mL, L.spans, p, MARK.ign);
    for (const p of res.ignoredPaths.right) mark(mR, R.spans, p, MARK.ign);
    for (const d of res.diffs) {
      if (d.kind === 'added') mark(mR, R.spans, d.rp, MARK.add);
      else if (d.kind === 'removed') mark(mL, L.spans, d.lp, MARK.del);
      else { mark(mL, L.spans, d.lp, MARK.chg); mark(mR, R.spans, d.rp, MARK.chg); }
    }
    const clip = s => (s.length > maxChars ? s.slice(0, maxChars - 1) + '…' : s);
    function build(P, m) {
      const n = P.lines.length;
      const full = [];
      for (let k = 0; k < Math.min(n, maxLines); k++) full.push([k + 1, MARK_CLASS[m[k]], clip(P.lines[k])]);
      // context: lines within ctx of a diff mark (ignored lines alone don't count)
      const keep = new Uint8Array(n);
      for (let k = 0; k < n; k++) if (m[k] && m[k] !== MARK.ign) { for (let q = Math.max(0, k - ctx); q <= Math.min(n - 1, k + ctx); q++) keep[q] = 1; }
      const context = [];
      let shown = 0, gap = 0, cut = false;
      for (let k = 0; k < n; k++) {
        if (!keep[k]) { gap++; continue; }
        if (shown >= maxLines) { cut = true; break; }
        if (gap) { context.push([0, 'gap', gap]); gap = 0; }
        context.push([k + 1, MARK_CLASS[m[k]], clip(P.lines[k])]); shown++;
      }
      if (gap && !cut) context.push([0, 'gap', gap]);
      return { total: n, full, fullCut: n > maxLines, context, contextCut: cut };
    }
    return { left: build(L, mL), right: build(R, mR) };
  }

  // ---------------------------------------------------------------- one call for the page (and the worker)

  function run(textA, textB, opts, viewOpts, cache) {
    const errors = [];
    let a, b;
    const t0 = Date.now();
    try { a = cache && cache.aText === textA ? cache.a : parse(textA, 'Before'); if (cache) { cache.aText = textA; cache.a = a; } } catch (e) { errors.push(errInfo(e, 'a')); }
    try { b = cache && cache.bText === textB ? cache.b : parse(textB, 'After'); if (cache) { cache.bText = textB; cache.b = b; } } catch (e) { errors.push(errInfo(e, 'b')); }
    if (errors.length) return { errors };
    const res = diff(a, b, opts);
    const view = viewOpts === false ? null : sideBySide(a, b, res, viewOpts);
    return { errors: [], result: res, view, ms: Date.now() - t0 };
  }
  function errInfo(e, side) {
    return { side, message: e.message, line: e.line, col: e.col, excerpt: e.excerpt, caret: e.caret, empty: !!e.empty };
  }

  const api = { parse, locateError, diff, run, preview, headline, toMarkdown, toJSON, assertions, sideBySide, prettyLines,
    compileIgnore, ignoredBy, describeOptions, typeOf, KIND_LABEL, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JsonDiff = api;

  // Web Worker mode: the page creates new Worker('/tools/json-diff/diff.js') for big inputs.
  if (typeof window === 'undefined' && typeof importScripts === 'function' && typeof module === 'undefined') {
    const cache = {};
    root.onmessage = e => {
      const m = e.data || {};
      try { root.postMessage({ id: m.id, out: run(m.a, m.b, m.opts, m.view, cache) }); }
      catch (err) { root.postMessage({ id: m.id, fail: String(err && err.message || err) }); }
    };
  }
})(typeof self !== 'undefined' ? self : this);
