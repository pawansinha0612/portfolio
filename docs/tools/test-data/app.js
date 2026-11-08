/* UI for /tools/test-data/. Generation runs in a Web Worker (generate.js loaded as the worker script),
   with a chunked main-thread fallback. Nothing is uploaded. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const T = window.TestData;
  const TPL = T.templates();
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtNum = n => Number(n).toLocaleString('en-AU');
  function track(p) { if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: p, title: p, event: true }); }

  let tplKey = 'users';
  let columns = [];
  let last = null;        // { columns, preview, count, ms, needsQuotes, file, spec }
  let local = null;       // fallback result when there is no worker
  let worker = null, jobId = 0;
  const pending = new Map();

  // ---------------------------------------------------------------- column options per type

  const TYPE_GROUPS = [
    ['People', ['id', 'firstName', 'lastName', 'fullName', 'email', 'username', 'mobile', 'password']],
    ['Australian address', ['street', 'suburb', 'state', 'postcode', 'address']],
    ['Numbers, dates and lists', ['int', 'decimal', 'date', 'enum', 'bool', 'pattern', 'constant']],
    ['Text and business', ['company', 'productName', 'sentence', 'bsb', 'accountNumber']],
    ['Test cards (not real)', ['cardNumber', 'cardBrand', 'cardExpiry', 'cardCvv']],
    ['Orders (one row per line)', ['orderId', 'lineNo', 'lineSku', 'lineProduct', 'quantity', 'unitPrice', 'lineTotal', 'orderTotal']],
    ['Negative tests', ['fakeTfn', 'fakeMedicare']],
  ];
  const ORDER_TYPES = new Set(TYPE_GROUPS[5][1]);
  const NO_UNIQUE = new Set(['email', 'username', 'cardBrand', 'cardCvv', 'cardExpiry', 'constant'].concat([...ORDER_TYPES]));

  const year = new Date().getFullYear();
  const DEFAULTS = {
    id: { mode: 'sequence', start: 1 }, date: { min: (year - 1) + '-01-01', max: (year - 1) + '-12-31', format: 'iso' },
    int: { min: 1, max: 100 }, decimal: { min: 0, max: 1000, dp: 2 }, enum: { values: 'Bronze, Silver, Gold' },
    bool: { pct: 50 }, pattern: { pattern: 'ABC-####' }, password: { length: 14 }, sentence: { min: 6, max: 14 },
    username: { style: 'sequence', prefix: 'loadtest_user_', pad: 5 }, cardNumber: { mode: 'public', brand: 'any' },
    cardExpiry: { from: year + 1, to: year + 5 }, constant: { value: 'Password1!' },
  };

  function fields(c) {
    switch (c.type) {
      case 'id': return c.mode === 'uuid' ? [sel('mode', 'Kind', [['sequence', '1, 2, 3…'], ['uuid', 'UUID v4']])]
        : [sel('mode', 'Kind', [['sequence', '1, 2, 3…'], ['uuid', 'UUID v4']]), numF('start', 'Start'), txt('prefix', 'Prefix', 'CUST-', 7), numF('pad', 'Zero-pad to', 0)];
      case 'username': return c.style === 'name' ? [sel('style', 'Style', [['sequence', 'prefix + number'], ['name', 'from the name']])]
        : [sel('style', 'Style', [['sequence', 'prefix + number'], ['name', 'from the name']]), txt('prefix', 'Prefix', 'loadtest_user_', 12), numF('pad', 'Digits')];
      case 'email': return [txt('domain', 'Domain', 'example.com/.net/.org', 14)];
      case 'date': return [dateF('min', 'From'), dateF('max', 'To'), sel('format', 'Format',
        [['iso', '2025-01-31'], ['au', '31/01/2025'], ['us', '01/31/2025'], ['datetime', '2025-01-31T09:30:00Z'], ['epoch', 'Unix seconds']])];
      case 'int': return [numF('min', 'Min'), numF('max', 'Max')];
      case 'decimal': return [numF('min', 'Min', 'any'), numF('max', 'Max', 'any'), numF('dp', 'Decimals')];
      case 'enum': return [txt('values', 'Values (comma separated)', 'Bronze, Silver, Gold', 22), txt('weights', 'Weights (optional)', '6, 3, 1', 9)];
      case 'bool': return [numF('pct', '% true')];
      case 'constant': return [txt('value', 'Value', '', 14)];
      case 'pattern': return [txt('pattern', 'Pattern', 'ABC-####', 14)];
      case 'sentence': return [numF('min', 'Min words'), numF('max', 'Max words')];
      case 'password': return [numF('length', 'Length'), chk('upper', 'A–Z'), chk('lower', 'a–z'), chk('digit', '0–9'), chk('symbol', 'Symbols')];
      case 'cardNumber': return [sel('mode', 'Numbers', [['public', 'Public test numbers'], ['luhn', 'Luhn-valid on test BINs']]),
        sel('brand', 'Brand', [['any', 'Any'], ['visa', 'Visa'], ['mastercard', 'Mastercard'], ['amex', 'Amex']])];
      case 'cardExpiry': return [numF('from', 'From year'), numF('to', 'To year')];
      default: return [];
    }
  }
  const HINTS = {
    mobile: '04xx xxx xxx. Random, so some could be real: never send SMS to them.', fakeTfn: 'Always fails the ATO checksum.',
    fakeMedicare: 'Always fails the Medicare check digit.', address: 'Street, suburb, state and postcode in one field.',
    lineSku: 'Rows are order lines. Totals add up per order.', orderTotal: 'Sum of the line totals for the order.',
    bsb: 'Random, not checked against real branches.', cardBrand: 'Matches the test card number in the same row.',
    cardCvv: '3 digits, or 4 for Amex.',
  };
  const PATTERN_HELP = '# digit · ? letter A–Z · * letter or digit · [A-F] set · {3} or {2,4} repeat · \\ makes the next character literal';

  const sel = (k, label, opts) => ({ k, label, kind: 'sel', opts });
  const numF = (k, label, step) => ({ k, label, kind: 'num', step: step || 1 });
  const txt = (k, label, ph, size) => ({ k, label, kind: 'txt', ph, size });
  const dateF = (k, label) => ({ k, label, kind: 'date' });
  const chk = (k, label) => ({ k, label, kind: 'chk' });

  // ---------------------------------------------------------------- column editor

  const list = $('cols');

  function typeSelect(c, i) {
    return `<select class="c-type" data-i="${i}" aria-label="Type of column ${i + 1}">` + TYPE_GROUPS.map(([g, ts]) =>
      `<optgroup label="${esc(g)}">` + ts.map(t => `<option value="${t}"${t === c.type ? ' selected' : ''}>${esc(T.TYPE_LABELS[t])}</option>`).join('') + '</optgroup>').join('') + '</select>';
  }

  function fieldHtml(f, c, i) {
    const id = `c${i}-${f.k}`, v = c[f.k] == null ? '' : c[f.k];
    if (f.kind === 'chk') return `<label class="field opt" for="${id}"><input type="checkbox" id="${id}" data-i="${i}" data-k="${f.k}"${c[f.k] !== false ? ' checked' : ''}> ${esc(f.label)}</label>`;
    if (f.kind === 'sel') return `<label class="field opt" for="${id}">${esc(f.label)} <select id="${id}" data-i="${i}" data-k="${f.k}">` +
      f.opts.map(([val, lab]) => `<option value="${val}"${String(v) === val ? ' selected' : ''}>${esc(lab)}</option>`).join('') + '</select></label>';
    const type = f.kind === 'num' ? 'number' : f.kind === 'date' ? 'date' : 'text';
    const extra = f.kind === 'num' ? ` step="${f.step}"` : f.kind === 'txt' ? ` placeholder="${esc(f.ph || '')}" style="width:${f.size || 10}em"` : '';
    return `<label class="field opt" for="${id}">${esc(f.label)} <input type="${type}" id="${id}" data-i="${i}" data-k="${f.k}" value="${esc(v)}"${extra} spellcheck="false" autocomplete="off"></label>`;
  }

  function renderCols() {
    const hasOrder = columns.some(c => ORDER_TYPES.has(c.type));
    list.innerHTML = columns.map((c, i) => {
      const opts = fields(c).map(f => fieldHtml(f, c, i));
      if (hasOrder && !ORDER_TYPES.has(c.type)) opts.push(`<label class="field opt" for="c${i}-perOrder"><input type="checkbox" id="c${i}-perOrder" data-i="${i}" data-k="perOrder"${c.perOrder ? ' checked' : ''}> Same on every line of an order</label>`);
      const hint = c.type === 'pattern' ? PATTERN_HELP : HINTS[c.type];
      return `<li class="col-row">
        <div class="col-main">
          <label class="sr-only" for="c${i}-name">Column ${i + 1} name</label>
          <input class="c-name" id="c${i}-name" data-i="${i}" data-k="name" value="${esc(c.name)}" spellcheck="false" autocomplete="off">
          ${typeSelect(c, i)}
          ${NO_UNIQUE.has(c.type) ? '' : `<label class="field" for="c${i}-unique"><input type="checkbox" id="c${i}-unique" data-i="${i}" data-k="unique"${c.unique ? ' checked' : ''}> Unique</label>`}
          <span class="col-tools">
            <button type="button" class="icon-btn" data-move="-1" data-i="${i}" aria-label="Move column ${i + 1} up"${i ? '' : ' disabled'}>↑</button>
            <button type="button" class="icon-btn" data-move="1" data-i="${i}" aria-label="Move column ${i + 1} down"${i < columns.length - 1 ? '' : ' disabled'}>↓</button>
            <button type="button" class="icon-btn" data-del="${i}" aria-label="Remove column ${i + 1}"${columns.length > 1 ? '' : ' disabled'}>✕</button>
          </span>
        </div>
        ${opts.length || hint ? `<div class="col-opts">${opts.join('')}${hint ? `<span class="col-hint">${esc(hint)}</span>` : ''}</div>` : ''}
      </li>`;
    }).join('');
  }

  list.addEventListener('input', e => {
    const el = e.target, i = +el.dataset.i, k = el.dataset.k;
    if (!k || isNaN(i)) return;
    columns[i][k] = el.type === 'checkbox' ? el.checked : el.value;
  });
  list.addEventListener('change', e => {
    const el = e.target, i = +el.dataset.i;
    if (el.classList.contains('c-type')) {
      const c = columns[i];
      columns[i] = Object.assign({ name: c.name, type: el.value }, DEFAULTS[el.value] || {});
      renderCols();
      const again = list.querySelector(`.c-type[data-i="${i}"]`); if (again) again.focus();
    } else if (el.dataset.k === 'mode' || el.dataset.k === 'style') {
      columns[i][el.dataset.k] = el.value;
      renderCols();
      const again = $(`c${i}-${el.dataset.k}`); if (again) again.focus();
    }
  });
  list.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.del != null) { columns.splice(+b.dataset.del, 1); renderCols(); }
    else if (b.dataset.move) {
      const i = +b.dataset.i, j = i + +b.dataset.move;
      if (j < 0 || j >= columns.length) return;
      [columns[i], columns[j]] = [columns[j], columns[i]];
      renderCols();
      const again = list.querySelector(`[data-move="${b.dataset.move}"][data-i="${j}"]`); if (again && !again.disabled) again.focus();
    }
  });
  $('add-col').addEventListener('click', () => {
    let n = columns.length + 1, name;
    const names = new Set(columns.map(c => c.name));
    do { name = 'column_' + n++; } while (names.has(name));
    columns.push(Object.assign({ name, type: 'int' }, DEFAULTS.int));
    renderCols();
    const inp = $(`c${columns.length - 1}-name`); if (inp) { inp.focus(); inp.select(); }
  });

  function useTemplate(key, run) {
    tplKey = key;
    columns = TPL[key].columns.map(c => Object.assign({}, c));
    document.querySelectorAll('[data-tpl]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tpl === key)));
    $('table').value = key === 'custom' ? 'test_data' : TPL[key].file.replace(/-/g, '_');
    renderCols();
    if (run) go();
  }
  document.querySelectorAll('[data-tpl]').forEach(b => b.addEventListener('click', () => { useTemplate(b.dataset.tpl, true); track('testdata-tpl-' + b.dataset.tpl); }));

  const WORDS = ['wattle', 'harbour', 'quokka', 'banksia', 'magpie', 'billabong', 'kelpie', 'mallee', 'galah', 'brumby', 'yabby', 'bilby'];
  $('new-seed').addEventListener('click', () => {
    const r = new Uint32Array(2); crypto.getRandomValues(r);
    $('seed').value = WORDS[r[0] % WORDS.length] + '-' + (r[1] % 9000 + 1000);
  });

  // ---------------------------------------------------------------- running the generator

  const err = $('err'), out = $('result'), prog = $('progress');
  function showErr(m) { err.textContent = m || ''; err.hidden = !m; }
  function progress(done, total) {
    if (done == null) { prog.hidden = true; return; }
    prog.hidden = false;
    prog.querySelector('.fill').style.width = Math.round(done / total * 100) + '%';
    prog.querySelector('.ptext').textContent = 'Generating… ' + fmtNum(done) + ' of ' + fmtNum(total) + ' rows';
  }

  function getWorker() {
    if (worker === false) return null;
    if (worker) return worker;
    try {
      worker = new Worker('/tools/test-data/generate.js');
      worker.onmessage = e => {
        const m = e.data, p = pending.get(m.id);
        if (!p) return;
        if (m.type === 'progress') { if (p.onProgress) p.onProgress(m.done, m.total); return; }
        pending.delete(m.id);
        if (m.type === 'error') { const x = new Error(m.message); x.code = m.code; p.reject(x); } else p.resolve(m);
      };
      worker.onerror = e => {
        e.preventDefault();
        worker = false;
        for (const p of pending.values()) p.reject(new Error('worker'));
        pending.clear();
      };
    } catch (e) { worker = false; }
    return worker || null;
  }
  function ask(msg, onProgress) {
    const w = getWorker();
    if (!w) return Promise.reject(new Error('worker'));
    const id = ++jobId;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject, onProgress }); w.postMessage(Object.assign({ id }, msg)); });
  }

  // main-thread fallback, in chunks so the page stays responsive
  function runLocal(spec) {
    return new Promise((resolve, reject) => {
      let g;
      try { g = T.createGenerator(spec); } catch (e) { reject(e); return; }
      const rows = [], t0 = performance.now();
      (function chunk() {
        try {
          const end = Math.min(g.total, rows.length + 4000);
          while (rows.length < end) rows.push(g.next());
          progress(rows.length, g.total);
          if (rows.length < g.total) { setTimeout(chunk, 0); return; }
          local = { columns: g.columns, rows };
          resolve({ columns: g.columns, preview: rows.slice(0, 20), count: rows.length, ms: Math.round(performance.now() - t0), needsQuotes: T.csvNeedsQuotes(local) });
        } catch (e) { reject(e); }
      })();
    });
  }

  function buildSpec() {
    return { rows: Math.floor(+$('rows').value), seed: $('seed').value.trim() || '1', columns: columns.map(c => Object.assign({}, c)) };
  }

  let running = false;
  async function go() {
    if (running) return;
    showErr('');
    const spec = buildSpec();
    if (!(spec.rows >= 1 && spec.rows <= T.MAX_ROWS)) { showErr('Rows must be between 1 and ' + fmtNum(T.MAX_ROWS) + '.'); return; }
    // check the spec up front, so errors such as "not enough unique values" show at once
    try { T.createGenerator(spec); } catch (e) { showErr(e.message); out.hidden = true; return; }
    running = true;
    $('go').disabled = true;
    progress(0, spec.rows);
    try {
      let res;
      try { res = await ask({ cmd: 'generate', spec }, progress); local = null; }
      catch (e) { if (e.message !== 'worker') throw e; res = await runLocal(spec); }
      last = Object.assign(res, { file: tplKey === 'custom' ? 'test-data' : TPL[tplKey].file, spec });
      render();
      track('testdata-generate');
    } catch (e) {
      showErr(e.message || String(e));
      out.hidden = true;
    } finally {
      running = false;
      $('go').disabled = false;
      progress(null);
    }
  }
  $('go').addEventListener('click', go);
  $('form').addEventListener('submit', e => { e.preventDefault(); go(); });

  async function exportText(fmt) {
    const opts = fmt === 'sql' ? { table: $('table').value.trim() || 'test_data', dialect: $('dialect').value } : {};
    if (local) return fmt === 'json' ? T.toJSON(local) : fmt === 'sql' ? T.toSQL(local, opts) : T.toCSV(local, opts);
    return (await ask({ cmd: 'export', fmt, opts })).text;
  }

  function dl(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // ---------------------------------------------------------------- output

  function k6Snippet(file, cols) {
    const name = file.replace(/[^a-z0-9]+/gi, '_');
    const props = cols.slice(0, 3).map(c => /^[A-Za-z_$][\w$]*$/.test(c.name) ? 'row.' + c.name : `row['${c.name.replace(/'/g, "\\'")}']`).join(', ');
    return `import { SharedArray } from 'k6/data';
import exec from 'k6/execution';
import papaparse from 'https://jslib.k6.io/papaparse/5.1.1/index.js';

// Read the file once. SharedArray keeps one copy in memory for all virtual users.
const rows = new SharedArray('${name}', function () {
  return papaparse.parse(open('./${file}.csv'), { header: true, skipEmptyLines: true }).data;
});

export const options = { vus: 50, duration: '5m' };

export default function () {
  // One row per virtual user: VU 1 gets row 0, VU 2 gets row 1, and so on.
  const row = rows[(exec.vu.idInTest - 1) % rows.length];

  // Or a fresh row on every iteration, across all VUs:
  // const row = rows[exec.scenario.iterationInTest % rows.length];

  // Use the values, for example: ${props}
}`;
  }

  function jsonSnippet(file) {
    return `import { SharedArray } from 'k6/data';

// JSON keeps numbers and true/false typed. CSV values all arrive as strings.
const rows = new SharedArray('${file.replace(/[^a-z0-9]+/gi, '_')}', () => JSON.parse(open('./${file}.json')));`;
  }

  function jmeterSnippet(file, cols, quotes) {
    return `Add › Config Element › CSV Data Set Config

Filename:              ${file}.csv
File encoding:         UTF-8
Variable Names:        (leave empty: the header row names them)
Ignore first line:     False
Delimiter:             ,
Allow quoted data?:    ${quotes ? 'True   (some values contain commas, quotes or line breaks)' : 'False  (no value needs quotes)'}
Recycle on EOF?:       False
Stop thread on EOF?:   True
Sharing mode:          All threads

Then use ${cols.slice(0, 3).map(c => '${' + c.name + '}').join(', ')} in your samplers.`;
  }

  function render() {
    const r = last, h = [];
    const cols = r.columns;
    h.push(`<div class="verdict pass"><h2>${fmtNum(r.count)} rows ready</h2>
      <p>${cols.length} columns, seed <code>${esc(r.spec.seed)}</code>, made in ${r.ms < 1000 ? r.ms + ' ms' : (r.ms / 1000).toFixed(1) + ' s'}.
      The same seed and settings always give the same rows.</p>
      <div class="actions dl-row">
        <button class="btn btn-small" type="button" data-dl="csv">Download CSV</button>
        <button class="btn btn-ghost btn-small" type="button" data-dl="json">Download JSON</button>
        <button class="btn btn-ghost btn-small" type="button" data-dl="sql">Download SQL</button>
        <span class="copied" id="dl-note" aria-live="polite"></span>
      </div></div>`);
    if (cols.some(c => c.type === 'cardNumber')) h.push('<ul class="warnings"><li>Test card numbers only. They work in payment sandboxes and never in live mode. Don\'t use them against a production gateway.</li></ul>');

    const n = Math.min(20, r.preview.length);
    h.push(`<div class="block"><div class="block-head"><h3 id="pv-h">Preview: first ${n} of ${fmtNum(r.count)} rows</h3></div>
      <div class="tbl-wrap" tabindex="0" role="region" aria-labelledby="pv-h"><table class="data pv"><thead><tr>` +
      cols.map(c => `<th scope="col" class="${c.numeric ? '' : 'l'}">${esc(c.name)}</th>`).join('') + '</tr></thead><tbody>' +
      r.preview.map(row => '<tr>' + cols.map(c => `<td class="${c.numeric ? '' : 'l'}">${esc(T.cellText(c, row[c.name]))}</td>`).join('') + '</tr>').join('') +
      '</tbody></table></div></div>');

    const snips = [
      ['k6', 'k6: SharedArray + papaparse', k6Snippet(r.file, cols)],
      ['k6json', 'k6: the same data from JSON', jsonSnippet(r.file)],
      ['jmeter', 'JMeter: CSV Data Set Config', jmeterSnippet(r.file, cols, r.needsQuotes)],
    ];
    h.push('<div class="snips">' + snips.map(([id, title, code]) => `<div class="block"><div class="block-head"><h3 id="sn-${id}">${esc(title)}</h3>
      <div class="actions" style="margin:0"><button class="btn btn-ghost btn-small" type="button" data-copy="${id}">Copy</button><span class="copied" id="cp-${id}" aria-live="polite"></span></div></div>
      <pre class="code" tabindex="0" aria-labelledby="sn-${id}"><code id="code-${id}">${esc(code)}</code></pre></div>`).join('') + '</div>');
    h.push(`<p class="hint snip-hint">Save the file next to your k6 script, or next to the <code>.jmx</code> file for JMeter.
      With <em>Stop thread on EOF</em> and no recycling, you need at least as many rows as threads × iterations.
      To keep one row per JMeter thread for the whole test, put the CSV Data Set Config under a Once Only Controller with the login request.</p>`);

    out.innerHTML = h.join('');
    out.hidden = false;

    out.querySelectorAll('[data-dl]').forEach(b => b.addEventListener('click', async () => {
      const fmt = b.dataset.dl, note = $('dl-note');
      note.textContent = 'Preparing…';
      try {
        const text = await exportText(fmt);
        const ext = fmt === 'json' ? 'json' : fmt === 'sql' ? 'sql' : 'csv';
        dl(r.file + '.' + ext, text, fmt === 'json' ? 'application/json' : fmt === 'sql' ? 'application/sql' : 'text/csv');
        note.textContent = 'Saved ' + r.file + '.' + ext + ' (' + (text.length > 1048576 ? (text.length / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(text.length / 1024)) + ' KB') + ').';
        track('testdata-dl-' + fmt);
      } catch (e) { note.textContent = 'Could not build the file: ' + (e.message || e); }
    }));
    out.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', async () => {
      const id = b.dataset.copy;
      try { await navigator.clipboard.writeText($('code-' + id).textContent); $('cp-' + id).textContent = 'Copied.'; }
      catch (e) { $('cp-' + id).textContent = 'Clipboard blocked. Select the text and copy it.'; }
      track('testdata-copy-' + id);
    }));
  }

  useTemplate('users', false);
  go();
})();
