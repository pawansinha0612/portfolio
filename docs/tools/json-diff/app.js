/* UI for /tools/json-diff/. Logic lives in diff.js (window.JsonDiff). Big inputs are compared in a Web Worker
   running the same diff.js, so the page stays responsive. Nothing is uploaded. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const D = window.JsonDiff;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inA = $('in-a'), inB = $('in-b'), out = $('result'), errBox = $('err'), working = $('working');
  const WORKER_MIN = 300000; // characters (both sides together) before we use the worker
  const VIEW = { context: 3, maxLines: 3000, maxChars: 300 };

  let last = null;     // { result, view }
  let kindFilter = 'all', query = '', nearOnly = true, showAsserts = false;
  let worker = null, seq = 0, timer = 0;

  function track(p) { if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: p, title: p, event: true }); }
  const fmtSize = n => (n < 1024 ? n + ' bytes' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB');
  const num = n => n.toLocaleString('en-AU');

  // ---------------------------------------------------------------- options

  function opts() {
    const tol = parseFloat($('o-tol').value);
    return {
      ignoreKeys: $('o-ignore').value,
      ignoreOrder: $('o-order').checked,
      matchKey: $('o-order').checked ? $('o-key').value.trim() : '',
      tolerance: isFinite(tol) && tol > 0 ? tol : 0,
      nullEqualsMissing: $('o-null').checked,
    };
  }
  function setOpts(o) {
    $('o-ignore').value = o.ignoreKeys || '';
    $('o-order').checked = !!o.ignoreOrder;
    $('o-key').value = o.matchKey || '';
    $('o-key').disabled = !o.ignoreOrder;
    $('o-tol').value = o.tolerance ? String(o.tolerance) : '';
    $('o-null').checked = !!o.nullEqualsMissing;
  }
  $('o-order').addEventListener('change', () => { $('o-key').disabled = !$('o-order').checked; });
  ['o-ignore', 'o-key', 'o-tol'].forEach(id => $(id).addEventListener('input', () => rerunSoon(350)));
  ['o-order', 'o-null'].forEach(id => $(id).addEventListener('change', () => rerunSoon(0)));
  function rerunSoon(ms) { if (!last) return; clearTimeout(timer); timer = setTimeout(compare, ms); }

  // ---------------------------------------------------------------- running

  function status(side, text, cls) { const el = $('st-' + side); el.textContent = text; el.className = 'side-status ' + (cls || ''); }

  function showErrors(errors) {
    if (!errors.length) { errBox.hidden = true; errBox.innerHTML = ''; return; }
    errBox.innerHTML = errors.map(e => {
      let h = `<div>${esc(e.message)}</div>`;
      if (e.excerpt != null && !e.empty) {
        h += `<pre class="err-excerpt">${esc(e.excerpt)}\n${' '.repeat(Math.max(0, e.caret || 0))}^</pre>`;
        h += `<button class="btn btn-ghost btn-small" type="button" data-goto="${e.side}" data-line="${e.line}" data-col="${e.col}">Show me in the ${e.side === 'a' ? 'before' : 'after'} box</button>`;
      }
      return `<div class="err-item">${h}</div>`;
    }).join('<hr style="border:0;border-top:1px solid currentColor;opacity:.2;margin:10px 0">');
    errBox.hidden = false;
    errBox.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => gotoPos(b.dataset.goto, +b.dataset.line, +b.dataset.col)));
  }

  function gotoPos(side, line, col) {
    const ta = side === 'a' ? inA : inB;
    const text = ta.value;
    const off = text.charCodeAt(0) === 0xFEFF ? 1 : 0;
    let pos = off;
    for (let l = 1; l < line; l++) { const k = text.indexOf('\n', pos); if (k < 0) break; pos = k + 1; }
    pos += col - 1;
    ta.focus();
    ta.setSelectionRange(pos, Math.min(text.length, pos + 1));
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
    ta.scrollTop = Math.max(0, (line - 3) * lh);
  }

  function getWorker() {
    if (worker === false) return null;
    if (worker) return worker;
    try {
      worker = new Worker('/tools/json-diff/diff.js');
      worker.onerror = () => { worker = false; };
    } catch (e) { worker = false; }
    return worker || null;
  }

  function runInWorker(a, b, o) {
    return new Promise((resolve, reject) => {
      const w = getWorker();
      if (!w) return reject(new Error('no worker'));
      const id = ++seq;
      const done = () => { w.removeEventListener('message', onMsg); w.removeEventListener('error', onErr); };
      const onMsg = e => {
        if (!e.data || e.data.id !== id) return;
        done();
        if (e.data.fail) reject(new Error(e.data.fail)); else resolve(e.data.out);
      };
      const onErr = () => { done(); worker = false; reject(new Error('no worker')); };
      w.addEventListener('message', onMsg);
      w.addEventListener('error', onErr);
      w.postMessage({ id, a, b, opts: o, view: VIEW });
    });
  }

  let running = 0;
  async function compare(scroll) {
    const a = inA.value, b = inB.value;
    const o = opts();
    const my = ++running;
    let r;
    const big = a.length + b.length > WORKER_MIN;
    if (big) working.hidden = false;
    try {
      if (big && getWorker()) {
        try { r = await runInWorker(a, b, o); }
        catch (e) { if (e.message !== 'no worker') throw e; r = D.run(a, b, o, VIEW); }
      } else {
        r = D.run(a, b, o, VIEW);
      }
    } catch (e) {
      r = { errors: [{ side: 'a', message: 'Something went wrong while comparing: ' + (e.message || e) }] };
    }
    if (my !== running) return; // a newer run started
    working.hidden = true;
    inA.classList.toggle('bad', r.errors.some(e => e.side === 'a' && !e.empty));
    inB.classList.toggle('bad', r.errors.some(e => e.side === 'b' && !e.empty));
    for (const side of ['a', 'b']) {
      const e = r.errors.find(x => x.side === side);
      const text = side === 'a' ? a : b;
      if (e) status(side, e.empty ? 'Empty' : '✗ Not valid JSON' + (e.line ? ' (line ' + e.line + ', column ' + e.col + ')' : ''), 'bad');
      else status(side, '✓ Valid JSON · ' + fmtSize(text.length), 'ok');
    }
    showErrors(r.errors);
    if (r.errors.length) { out.hidden = true; last = null; return; }
    last = r;
    render(scroll);
    if (scroll) track('json-diff-compare');
  }

  $('go').addEventListener('click', () => { showAsserts = false; compare(true); });
  [inA, inB].forEach(ta => ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); showAsserts = false; compare(true); }
  }));
  $('swap').addEventListener('click', () => {
    const t = inA.value; inA.value = inB.value; inB.value = t;
    if (last) compare(false);
  });
  $('clear').addEventListener('click', () => {
    inA.value = ''; inB.value = ''; last = null; out.hidden = true; out.innerHTML = '';
    showErrors([]); status('a', ''); status('b', ''); inA.classList.remove('bad'); inB.classList.remove('bad');
    $('ex-note').hidden = true; setPressed(null);
  });

  // ---------------------------------------------------------------- files

  let openSide = 'a';
  document.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => { openSide = b.dataset.open; $('file').value = ''; $('file').click(); }));
  $('file').addEventListener('change', async () => {
    const f = $('file').files[0];
    if (!f) return;
    if (f.size > 60e6) { status(openSide, '✗ ' + f.name + ' is ' + fmtSize(f.size) + '. That is too large to compare in a browser tab.', 'bad'); return; }
    (openSide === 'a' ? inA : inB).value = await f.text();
    status(openSide, f.name + ' · ' + fmtSize(f.size), '');
  });

  // ---------------------------------------------------------------- examples

  const EX = {
    version: {
      note: 'Version 1 and version 2 of an order endpoint, compared with no options. Notice the total that became a string, and the email that moved into a new object.',
      opts: {},
      a: { orderId: 'ORD-1042', status: 'PAID', customer: { id: 77, name: 'Mia Chen', email: 'mia@example.com' },
        items: [{ sku: 'BK-101', title: 'Load Testing in Practice', qty: 1, price: 24.95 }, { sku: 'BK-205', title: 'API Testing Field Guide', qty: 2, price: 12.5 }],
        total: 49.95, currency: 'AUD', shipping: { method: 'standard', eta: '2026-11-12' }, giftWrap: false },
      b: { orderId: 'ORD-1042', status: 'SHIPPED', customer: { id: 77, name: 'Mia Chen', contact: { email: 'mia@example.com', phone: '+61 400 000 000' } },
        items: [{ sku: 'BK-101', title: 'Load Testing in Practice', qty: 1, price: 24.95 }, { sku: 'BK-205', title: 'API Testing Field Guide', qty: '2', price: 13 }],
        total: '50.95', currency: 'AUD', shipping: { method: 'express', eta: '2026-11-10' }, tracking: { carrier: 'AusPost', number: 'AP7731920' } },
    },
    order: {
      note: 'The same search results in a different order, with one real price change. Ignore array order is on and products are matched by id, so only the price shows. Untick it to see the noise a position-by-position compare reports.',
      opts: { ignoreOrder: true, matchKey: 'id' },
      a: { query: 'k6', tags: ['sale', 'new', 'books'], results: [
        { id: 101, name: 'k6 starter kit', price: 49 }, { id: 102, name: 'JMeter to k6 workshop', price: 199 },
        { id: 103, name: 'Load test review', price: 450 }, { id: 104, name: 'SLO worksheet', price: 0 }] },
      b: { query: 'k6', tags: ['books', 'sale', 'new'], results: [
        { id: 103, name: 'Load test review', price: 450 }, { id: 101, name: 'k6 starter kit', price: 49 },
        { id: 104, name: 'SLO worksheet', price: 0 }, { id: 102, name: 'JMeter to k6 workshop', price: 249 }] },
    },
    volatile: {
      note: 'Two calls to the same endpoint a minute apart. Request ids, timestamps, trace ids and line ids change on every call, and the server rounds a little differently. The options set here hide all of that, leaving the one balance change. Clear Ignore keys to see the noise.',
      opts: { ignoreKeys: 'requestId, timestamp, *.traceId, $.data.lines[*].lineId', tolerance: 0.01, nullEqualsMissing: true },
      a: { requestId: 'c0a8-11ee-9f2b', timestamp: '2026-11-08T09:14:02.118Z',
        data: { account: 'ACC-2231', balance: 120.5, interestRate: 0.0435, nickname: null,
          lines: [{ lineId: 'b7f1e2', desc: 'Coffee', amount: -4.5 }, { lineId: '41aa09', desc: 'Salary', amount: 2500 }] },
        meta: { traceId: '4bf92f3577b34da6', page: 1 } },
      b: { requestId: 'c0a8-11ee-a771', timestamp: '2026-11-08T09:15:07.940Z',
        data: { account: 'ACC-2231', balance: 118.5, interestRate: 0.043500000000000004,
          lines: [{ lineId: '9c02d4', desc: 'Coffee', amount: -4.5 }, { lineId: 'e5d710', desc: 'Salary', amount: 2500.001 }] },
        meta: { traceId: '00f067aa0ba902b7', page: 1 } },
    },
  };
  function setPressed(btn) { document.querySelectorAll('[data-example]').forEach(b => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false')); }
  document.querySelectorAll('[data-example]').forEach(btn => btn.addEventListener('click', () => {
    const ex = EX[btn.dataset.example];
    inA.value = JSON.stringify(ex.a, null, 2);
    inB.value = JSON.stringify(ex.b, null, 2);
    setOpts(ex.opts);
    const note = $('ex-note');
    note.textContent = ex.note;
    note.hidden = false;
    setPressed(btn);
    showAsserts = false;
    compare(true);
    track('json-diff-example-' + btn.dataset.example);
  }));

  // ---------------------------------------------------------------- output

  const KINDS = [['all', 'All'], ['changed', 'Changed'], ['type', 'Type changes'], ['added', 'Added'], ['removed', 'Removed']];
  const MAX_ROWS = 500;

  function filtered() {
    const res = last.result, q = query.trim().toLowerCase();
    return res.diffs.filter(d => (kindFilter === 'all' || d.kind === kindFilter) && (!q || d.path.toLowerCase().indexOf(q) >= 0));
  }

  function valCell(d, side) {
    const missing = side === 'b' ? d.kind === 'removed' : d.kind === 'added';
    if (missing) return '<td class="v miss">missing</td>';
    const v = side === 'b' ? d.after : d.before;
    const t = side === 'b' ? d.afterType : d.beforeType;
    return `<td class="v">${esc(D.preview(v, 160))}${d.kind === 'type' || d.kind === 'added' || d.kind === 'removed' ? `<em>${esc(t)}</em>` : ''}</td>`;
  }

  function tableRows() {
    const rows = filtered();
    const shown = rows.slice(0, MAX_ROWS);
    const h = shown.map(d => {
      const moved = d.lp && d.rp && d.lp !== d.rp && d.kind !== 'added' && d.kind !== 'removed' ? `<small>was ${esc(d.lp)} in before</small>` : '';
      return `<tr class="k-${d.kind}"><td class="p">${esc(d.path)}${moved}</td><td><span class="pill ${d.kind}">${D.KIND_LABEL[d.kind]}</span></td>${valCell(d, 'a')}${valCell(d, 'b')}</tr>`;
    });
    if (!rows.length) h.push('<tr><td colspan="4" class="miss">No differences match this filter.</td></tr>');
    const note = rows.length > shown.length ? `Showing the first ${num(MAX_ROWS)} of ${num(rows.length)}. Filter by path to narrow it down. The exports include every difference.` : '';
    return { html: h.join(''), note };
  }

  function paneHtml(side, title) {
    const p = last.view[side];
    const list = nearOnly ? p.context : p.full;
    const cut = nearOnly ? p.contextCut : p.fullCut;
    const body = list.map(r => (r[1] === 'gap'
      ? `<div class="ln gap">⋯ ${num(r[2])} unchanged line${r[2] === 1 ? '' : 's'}</div>`
      : `<div class="ln ${r[1]}"><i>${r[0]}</i><span>${esc(r[2])}</span></div>`)).join('');
    const empty = !list.length ? '<div class="ln gap">No differences on this side.</div>' : '';
    return `<div class="pane"><h4>${title} · ${num(p.total)} lines${cut ? ` (first ${num(VIEW.maxLines)} shown)` : ''}</h4><div class="lines" tabindex="0" role="region" aria-label="${title}">${body || empty}</div></div>`;
  }

  function render(scroll) {
    const res = last.result, c = res.counts;
    const h = [];
    const cls = res.total ? 'warn' : 'pass';
    const opt = D.describeOptions(res.options);
    h.push(`<div class="verdict ${cls}"><h2>${esc(D.headline(res))}</h2>` +
      `<p>${res.total ? 'Every difference is listed below with its JSON path, the before value and the after value.' : 'The two documents are equal' + (opt === 'strict comparison' ? '.' : ' under the options you chose.')}</p>` +
      `<p class="fmt">Options: ${esc(opt)}${last.ms != null ? ' · compared in ' + num(last.ms) + ' ms' : ''}</p></div>`);
    h.push('<div class="ja-stats">' +
      `<div class="ja-stat chg"><b>${num(c.changed)}</b><span>changed</span></div>` +
      `<div class="ja-stat typ"><b>${num(c.type)}</b><span>type changes</span></div>` +
      `<div class="ja-stat add"><b>${num(c.added)}</b><span>added</span></div>` +
      `<div class="ja-stat del"><b>${num(c.removed)}</b><span>removed</span></div>` +
      `<div class="ja-stat ign"><b>${num(res.ignored)}</b><span>fields ignored</span></div></div>`);
    if (res.truncated) h.push(`<ul class="warnings"><li>Only the first ${num(res.diffs.length)} differences were kept. The counts above are complete. The documents are probably not two versions of the same response.</li></ul>`);

    if (res.total) {
      const t = tableRows();
      h.push(`<div class="block"><div class="block-head"><h3 id="d-h">Differences</h3>
        <div class="actions" style="margin:0"><button class="btn btn-small" type="button" id="copy-md">Copy as Markdown</button>
        <button class="btn btn-ghost btn-small" type="button" id="dl-json">Download .json</button>
        <button class="btn btn-ghost btn-small" type="button" id="gen">Generate assertions</button>
        <span class="copied" id="copied" aria-live="polite"></span></div></div>
        <div class="filters" role="group" aria-label="Filter differences">${KINDS.map(([k, l]) => {
          const n = k === 'all' ? res.total : c[k];
          return `<button class="chip-btn" type="button" data-kind="${k}" aria-pressed="${kindFilter === k}">${l} (${num(n)})</button>`;
        }).join('')}
        <label class="sr-only" for="q">Filter by path</label><input type="search" id="q" placeholder="Filter by path, e.g. items" value="${esc(query)}"></div>
        <div class="tbl-wrap" tabindex="0" role="region" aria-labelledby="d-h"><table class="data diff"><thead><tr>
        <th scope="col">Path</th><th scope="col">Change</th><th scope="col">Before</th><th scope="col">After</th></tr></thead>
        <tbody id="d-body">${t.html}</tbody></table></div><p class="hint" id="d-note">${esc(t.note)}</p>
        <div id="asserts"></div></div>`);
    }

    h.push(`<div class="block"><div class="block-head"><h3>Side by side</h3>
      <label class="field" style="cursor:pointer"><input type="checkbox" id="near" style="width:auto" ${nearOnly ? 'checked' : ''}> Only lines near differences</label></div>
      <div class="legend"><span><i style="background:var(--warn-bg);box-shadow:inset 0 0 0 1px var(--warn)"></i>Changed</span>
      <span><i style="background:var(--ok-bg);box-shadow:inset 0 0 0 1px var(--ok)"></i>Added</span>
      <span><i style="background:var(--bad-bg);box-shadow:inset 0 0 0 1px var(--bad)"></i>Removed</span>
      <span><i style="background:var(--alt);box-shadow:inset 0 0 0 1px var(--muted)"></i>Ignored (struck through)</span></div>
      <div class="sbs" id="sbs">${paneHtml('left', 'Before')}${paneHtml('right', 'After')}</div>
      <p class="hint">Both documents are pretty-printed with two-space indents. Line numbers refer to this view, not to what you pasted.</p></div>`);

    out.innerHTML = h.join('');
    out.hidden = false;
    wire();
    if (showAsserts) renderAsserts();
    if (scroll) out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function refreshTable() {
    const t = tableRows();
    $('d-body').innerHTML = t.html;
    $('d-note').textContent = t.note;
    out.querySelectorAll('[data-kind]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.kind === kindFilter)));
    if (showAsserts) renderAsserts();
  }

  function renderAsserts() {
    const res = Object.assign({}, last.result, { diffs: filtered() });
    const a = D.assertions(res);
    $('asserts').innerHTML = `<div class="block"><div class="block-head"><h3>Assertions for the after response</h3></div>
      <p class="hint" style="margin:0 0 10px">One line per difference in the table${kindFilter !== 'all' || query ? ' (filtered)' : ''}. Added or removed array items become a length check. Review them before you commit: some differences are bugs, not new behaviour.</p>
      <div class="asserts"><div><h4>Playwright <button type="button" data-copy="pw">Copy</button></h4><pre class="code-out" id="a-pw">${esc(a.playwright)}</pre></div>
      <div><h4>k6 <button type="button" data-copy="k6">Copy</button></h4><pre class="code-out" id="a-k6">${esc(a.k6)}</pre></div></div></div>`;
    $('asserts').querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', async () => {
      const text = b.dataset.copy === 'pw' ? a.playwright : a.k6;
      try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; } catch (e) { b.textContent = 'Select and copy'; }
      setTimeout(() => { b.textContent = 'Copy'; }, 1800);
      track('json-diff-copy-' + b.dataset.copy);
    }));
  }

  function wire() {
    const res = last.result;
    if (res.total) {
      out.querySelectorAll('[data-kind]').forEach(b => b.addEventListener('click', () => { kindFilter = b.dataset.kind; refreshTable(); }));
      $('q').addEventListener('input', e => { query = e.target.value; refreshTable(); });
      $('copy-md').addEventListener('click', async () => {
        const md = D.toMarkdown(res);
        try { await navigator.clipboard.writeText(md); $('copied').textContent = 'Copied. Paste it into your ticket or PR.'; }
        catch (e) { dl('json-diff.md', md, 'text/markdown'); $('copied').textContent = 'Clipboard blocked, so it was downloaded instead.'; }
        track('json-diff-copy-md');
      });
      $('dl-json').addEventListener('click', () => { dl('json-diff.json', D.toJSON(res), 'application/json'); track('json-diff-dl-json'); });
      $('gen').addEventListener('click', () => {
        showAsserts = true; renderAsserts();
        $('asserts').scrollIntoView({ behavior: 'smooth', block: 'start' });
        track('json-diff-assertions');
      });
    }
    $('near').addEventListener('change', e => {
      nearOnly = e.target.checked;
      $('sbs').innerHTML = paneHtml('left', 'Before') + paneHtml('right', 'After');
    });
  }

  function dl(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
})();
