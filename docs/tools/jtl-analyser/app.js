/* UI for /tools/jtl-analyser/. Parsing lives in jtl.js (and runs in worker.js). Nothing is uploaded. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const J = window.JTL;
  const { esc, fmtMs, fmtNum, fmtPct, fmtDuration } = J;
  let current = null;      // last result
  let currentName = '';
  let sort = { key: null, dir: 1 };

  const fileIn = $('jtl-file'), drop = $('drop'), err = $('err'), prog = $('progress'), out = $('result');

  // ---------------------------------------------------------------- input

  function showErr(msg) { err.textContent = msg; err.hidden = !msg; }

  function setProgress(done, total, rows) {
    prog.hidden = false;
    const indet = !(done >= 0) || !total;
    prog.classList.toggle('indet', indet);
    prog.querySelector('.fill').style.width = indet ? '' : Math.round((done / total) * 100) + '%';
    prog.querySelector('.ptext').textContent = (indet ? 'Reading… ' : `Reading ${Math.round((done / total) * 100)}% · `) +
      fmtNum(rows) + ' rows so far';
  }

  async function runFile(file) {
    showErr('');
    out.hidden = true;
    currentName = file.name;
    drop.querySelector('.fname').textContent = file.name + ' · ' + (file.size / 1e6).toFixed(1) + ' MB';
    setProgress(0, file.size, 0);
    const t0 = performance.now();
    try {
      const r = await J.analyse(file, { buckets: 120 }, (done, rows) => setProgress(done, file.size, rows));
      r.elapsedMs = performance.now() - t0;
      prog.hidden = true;
      show(r);
      track('jtl-analysed');
    } catch (e) {
      prog.hidden = true;
      showErr(e.message || String(e));
    }
  }

  fileIn.addEventListener('change', () => { if (fileIn.files[0]) runFile(fileIn.files[0]); });
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove('over')));
  drop.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) runFile(f); });

  $('sample').addEventListener('click', () => {
    const text = J.generateSample({ rows: 20000 });
    runFile(new File([text], 'sample-shop-test.jtl', { type: 'text/csv' }));
  });
  $('sample-dl').addEventListener('click', () => download('sample-shop-test.jtl', J.generateSample({ rows: 20000 }), 'text/csv'));

  $('sla').addEventListener('input', () => { if (current) show(current, true); });

  function slaMs() { const v = parseFloat($('sla').value); return v > 0 ? v : null; }

  function track(path) {
    if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path, title: path, event: true });
  }

  // ---------------------------------------------------------------- output

  function show(r, keepScroll) {
    current = r;
    const sla = slaMs();
    const t = r.total;
    const slow = sla ? r.labels.filter(l => l.p95 > sla) : [];
    const level = t.errPct >= 5 || slow.length ? 'fail' : t.errPct >= 1 ? 'warn' : 'pass';
    const h = [];
    const headline = level === 'pass' ? 'Healthy run' + (sla ? `: every transaction's p95 is under ${fmtMs(sla)}` : '')
      : slow.length ? `${slow.length} of ${r.labels.length} transactions over your ${fmtMs(sla)} p95 target` + (t.errPct >= 1 ? `, ${fmtPct(t.errPct)} errors` : '')
        : `${fmtPct(t.errPct)} of requests failed`;
    const worst = r.labels.slice().sort((a, b) => b.p95 - a.p95)[0];
    h.push(`<div class="verdict ${level}"><h2>${esc(headline)}</h2>` +
      `<p>${fmtNum(r.rows)} samples over ${r.hasTs ? fmtDuration(r.durationMs) : 'an unknown time span'} across ${r.labels.length} transaction${r.labels.length === 1 ? '' : 's'}. ` +
      `Slowest at p95: <b>${esc(worst.label)}</b> (${fmtMs(worst.p95)}).</p>` +
      `<p class="fmt">${esc(currentName)} · read as ${esc(r.format)}${r.hasTs ? ' · started ' + esc(new Date(r.start).toLocaleString('en-AU')) : ''}` +
      `${r.elapsedMs ? ' · analysed in ' + (r.elapsedMs / 1000).toFixed(1) + ' s on your machine' : ''}</p></div>`);
    const stat = (v, l, c) => `<div class="ja-stat ${c || ''}"><b>${v}</b><span>${l}</span></div>`;
    h.push('<div class="ja-stats">' +
      stat(fmtNum(r.rows), 'samples') +
      stat(fmtPct(t.errPct), 'errors', t.errPct >= 5 ? 'bad' : t.errPct >= 1 ? 'warn' : '') +
      stat(isNaN(t.tput) ? 'n/a' : t.tput.toFixed(1) + '/s', 'throughput') +
      stat(fmtMs(t.avg), 'average') +
      stat(fmtMs(t.p95), '95th percentile', sla && t.p95 > sla ? 'bad' : '') +
      stat(fmtMs(t.p99), '99th percentile') + '</div>');
    if (r.warnings && r.warnings.length) h.push('<ul class="warnings">' + r.warnings.map(w => `<li>${esc(w)}</li>`).join('') + '</ul>');

    // summary table
    h.push(`<div class="block"><div class="block-head"><h3 id="sum-h">Summary per transaction</h3>
      <div class="actions" style="margin:0"><button class="btn btn-small" type="button" id="copy-md" data-track="jtl-copy-md">Copy as Markdown</button>
      <button class="btn btn-ghost btn-small" type="button" id="dl-csv" data-track="jtl-csv">Download CSV</button>
      <span class="copied" id="copied" aria-live="polite"></span></div></div>
      <div class="tbl-wrap" tabindex="0" role="region" aria-labelledby="sum-h">${summaryTable(r, sla)}</div>
      <p class="hint">Click a column to sort. Percentiles are exact (nearest-rank, as in JMeter's Aggregate Report). Throughput = samples ÷ time from that transaction's first start to its last end. ${sla ? `▲ = p95 above ${fmtMs(sla)}.` : 'Set a p95 target above to flag slow transactions.'}</p></div>`);

    // charts
    if (r.timeline && r.timeline.points.length > 1) {
      h.push(`<div class="block"><div class="block-head"><h3>Over time</h3><div class="ja-chart-tools">
        <span>${esc(bucketText(r.timeline.bucketMs))} buckets</span>
        <label><input type="checkbox" id="logscale"${logScale ? ' checked' : ''}> Log scale for response times</label></div></div>
        <div class="ja-charts" id="charts"></div>
        <p class="hint">Hover or tap a chart to read a point. All transactions combined. Percentiles per bucket are exact too.</p></div>`);
    }

    // errors
    if (r.errors.length) {
      h.push(`<div class="block"><div class="block-head"><h3 id="err-h">Top errors</h3></div><div class="tbl-wrap" tabindex="0" role="region" aria-labelledby="err-h"><table class="data"><thead><tr>
        <th scope="col">Response code</th><th scope="col" class="l">Message</th><th scope="col">Count</th><th scope="col">% of errors</th><th scope="col" class="l">Mostly in</th></tr></thead><tbody>` +
        r.errors.map(e => `<tr><td class="code">${esc(e.rc || '—')}</td><td class="msg">${esc(e.msg.length > 300 ? e.msg.slice(0, 300) + '…' : e.msg || '—')}</td>` +
          `<td>${fmtNum(e.count)}</td><td>${fmtPct(e.pctOfErrors)}</td><td class="msg">${e.labels.map(l => esc(l.label) + ' (' + fmtNum(l.count) + ')').join(', ')}</td></tr>`).join('') +
        '</tbody></table></div><p class="hint">Grouped by response code + failure message (or response message when there is no assertion failure).</p></div>');
    }

    // slowest samples
    if (r.slowest.length) {
      h.push(`<div class="block"><div class="block-head"><h3 id="slow-h">Slowest individual samples</h3></div><div class="tbl-wrap" tabindex="0" role="region" aria-labelledby="slow-h"><table class="data"><thead><tr>
        <th scope="col">Transaction</th><th scope="col">Elapsed</th><th scope="col">When</th><th scope="col">Result</th></tr></thead><tbody>` +
        r.slowest.map(s => `<tr><td>${esc(s.label)}</td><td>${fmtMs(s.elapsed)}</td><td>${r.hasTs ? '+' + clock(s.t - r.start) : 'n/a'}</td><td>${s.success ? 'OK' : '<span style="color:var(--bad);font-weight:600">failed</span>'}</td></tr>`).join('') +
        '</tbody></table></div><p class="hint">Times close to a round number (30 s, 60 s) are usually a timeout, not a slow server response.</p></div>');
    }

    out.innerHTML = h.join('');
    out.hidden = false;
    bindResult();
    drawCharts();
    if (!keepScroll) out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const COLS = [
    ['label', 'Transaction'], ['count', 'Samples'], ['errPct', 'Error %'], ['avg', 'Avg'], ['p50', 'p50'], ['p90', 'p90'],
    ['p95', 'p95'], ['p99', 'p99'], ['max', 'Max'], ['tput', 'Req/s'], ['recvKBs', 'KB/s in'], ['sentKBs', 'KB/s out'],
  ];

  function cell(k, v) {
    if (k === 'count') return fmtNum(v);
    if (k === 'errPct') return fmtPct(v);
    if (k === 'tput') return isNaN(v) ? 'n/a' : v.toFixed(2);
    if (k === 'recvKBs' || k === 'sentKBs') return isNaN(v) ? 'n/a' : v.toFixed(1);
    return fmtMs(v);
  }

  function summaryTable(r, sla) {
    let rows = r.labels.slice();
    if (sort.key) rows.sort((a, b) => {
      const x = a[sort.key], y = b[sort.key];
      return (typeof x === 'string' ? x.localeCompare(y, 'en', { numeric: true }) : (x || 0) - (y || 0)) * sort.dir;
    });
    const head = COLS.map(([k, n]) => `<th scope="col" aria-sort="${sort.key === k ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" data-sort="${k}">${n}</button></th>`).join('');
    const tr = (l, isTotal) => {
      const slow = !isTotal && sla && l.p95 > sla;
      return `<tr class="${isTotal ? 'total' : ''}${slow ? ' slow-row' : ''}">` + COLS.map(([k]) => {
        if (k === 'label') return `<td>${esc(l.label)}${l.transactionController ? '<span class="ja-tag" title="JMeter Transaction Controller">TC</span>' : ''}</td>`;
        const cls = (k === 'p95' && slow) ? ' class="slow"' : (k === 'errPct' && l.errPct > 0 && !isTotal) ? ' class="errs"' : '';
        return `<td${cls}>${cell(k, l[k])}</td>`;
      }).join('') + '</tr>';
    };
    return `<table class="data" id="sum-table"><thead><tr>${head}</tr></thead><tbody>${rows.map(l => tr(l)).join('')}${tr(r.total, true)}</tbody></table>`;
  }

  function bindResult() {
    out.querySelectorAll('[data-sort]').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.sort;
      sort = { key: k, dir: sort.key === k ? -sort.dir : (k === 'label' ? 1 : -1) };
      out.querySelector('#sum-table').outerHTML = summaryTable(current, slaMs());
      bindResult();
      const btn = out.querySelector(`[data-sort="${k}"]`); if (btn) btn.focus();
    }));
    const cp = $('copy-md');
    if (cp && !cp.dataset.bound) {
      cp.dataset.bound = 1;
      cp.addEventListener('click', async () => {
        const md = J.toMarkdown(current, { slaMs: slaMs(), fileName: currentName });
        try { await navigator.clipboard.writeText(md); $('copied').textContent = 'Copied. Paste it into your ticket.'; }
        catch (e) { download('load-test-summary.md', md, 'text/markdown'); $('copied').textContent = 'Clipboard blocked, so it was downloaded instead.'; }
        track('jtl-copy-md');
      });
      $('dl-csv').addEventListener('click', () => { download(currentName.replace(/\.[^.]+$/, '') + '-summary.csv', J.toSummaryCsv(current), 'text/csv'); track('jtl-csv'); });
    }
    const ls = $('logscale');
    if (ls && !ls.dataset.bound) { ls.dataset.bound = 1; ls.addEventListener('change', () => { logScale = ls.checked; drawCharts(); }); }
  }

  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------------------------------------------------------------- charts (inline SVG, no libraries)

  let logScale = false;

  function bucketText(ms) { return ms >= 3600000 ? ms / 3600000 + ' h' : ms >= 60000 ? ms / 60000 + ' min' : ms / 1000 + ' s'; }
  function clock(ms) {
    const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
  }

  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }

  function drawCharts() {
    const host = $('charts');
    if (!host || !current || !current.timeline) return;
    const pts = current.timeline.points;
    const specs = [
      { title: 'Response time percentiles', fmt: fmtMs, log: logScale, series: [
        { key: 'p50', name: 'p50', color: 'var(--s-p50)' }, { key: 'p90', name: 'p90', color: 'var(--s-p90)' },
        { key: 'p95', name: 'p95', color: 'var(--s-p95)' }, { key: 'p99', name: 'p99', color: 'var(--s-p99)' }] },
      { title: 'Throughput (requests per second)', fmt: v => v.toFixed(v < 10 ? 2 : 1) + '/s', series: [{ key: 'tput', name: 'req/s', color: 'var(--s-tput)' }] },
      { title: 'Errors per bucket', fmt: v => fmtNum(v), series: [{ key: 'errors', name: 'errors', color: 'var(--s-err)' }], extra: p => p.count ? fmtPct(p.errors / p.count * 100) + ' of requests' : '' },
    ];
    if (current.hasThreads) specs.push({ title: 'Active threads (virtual users)', fmt: v => fmtNum(v), series: [{ key: 'threads', name: 'threads', color: 'var(--s-thr)' }] });
    host.innerHTML = specs.map((s, i) => `<figure class="ja-chart" style="margin:0" data-i="${i}"><h4>${esc(s.title)}</h4>` +
      (s.series.length > 1 ? '<div class="ja-legend">' + s.series.map(x => `<span><i style="background:${x.color}"></i>${esc(x.name)}</span>`).join('') + '</div>' : '') +
      '<div class="svg-host"></div><div class="tip" hidden></div></figure>').join('');
    host.querySelectorAll('.ja-chart').forEach(fig => {
      const spec = specs[+fig.dataset.i];
      const w = Math.max(260, fig.querySelector('.svg-host').clientWidth);
      fig.querySelector('.svg-host').innerHTML = chartSvg(pts, spec, w, 190);
      hover(fig, pts, spec, w);
    });
  }

  const PAD = { l: 52, r: 12, t: 8, b: 24 };

  function chartSvg(pts, spec, W, H) {
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
    let max = 0, min = Infinity;
    for (const p of pts) for (const s of spec.series) { const v = p[s.key]; if (v === v && v >= 0) { if (v > max) max = v; if (v > 0 && v < min) min = v; } }
    let y, ticks;
    if (spec.log) {
      const lo = Math.pow(10, Math.floor(Math.log10(min === Infinity ? 1 : min))), hi = Math.pow(10, Math.ceil(Math.log10(Math.max(max, lo * 10))));
      y = v => PAD.t + ih - (Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) * ih;
      ticks = []; for (let v = lo; v <= hi * 1.001; v *= 10) ticks.push(v);
    } else {
      const top = niceMax(max);
      y = v => PAD.t + ih - (v / top) * ih;
      const m = top / Math.pow(10, Math.floor(Math.log10(top))), k = m === 2.5 || m === 5 ? 5 : 4;
      ticks = []; for (let i = 0; i <= k; i++) ticks.push((top * i) / k);
    }
    const x = t => PAD.l + (t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * iw);
    const g = [];
    for (const v of ticks) g.push(`<line class="gl" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${PAD.l - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(spec.fmt(v))}</text>`);
    const xt = Math.min(6, Math.max(2, Math.floor(iw / 90)));
    for (let i = 0; i <= xt; i++) {
      const t = t0 + ((t1 - t0) * i) / xt;
      g.push(`<text x="${x(t).toFixed(1)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === xt ? 'end' : 'middle'}">${clock(t - current.start)}</text>`);
    }
    for (const s of spec.series) {
      let d = '', pen = false;
      for (const p of pts) {
        const v = p[s.key];
        if (!(v === v) || v < 0 || (s.key !== 'errors' && s.key !== 'tput' && !p.count)) { pen = false; continue; }
        d += (pen ? 'L' : 'M') + x(p.t).toFixed(1) + ' ' + y(v).toFixed(1);
        pen = true;
      }
      g.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    }
    g.push(`<line class="xh" x1="0" x2="0" y1="${PAD.t}" y2="${PAD.t + ih}" visibility="hidden"/>`);
    g.push(`<rect class="hit" x="${PAD.l}" y="0" width="${iw}" height="${H}" fill="transparent"/>`);
    const label = spec.title + ' over time, ' + spec.series.map(s => s.name).join(', ');
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">${g.join('')}</svg>`;
  }

  function hover(fig, pts, spec, W) {
    const svg = fig.querySelector('svg'), tip = fig.querySelector('.tip'), xh = svg.querySelector('.xh');
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t, iw = W - PAD.l - PAD.r;
    function at(clientX) {
      const r = svg.getBoundingClientRect();
      const px = ((clientX - r.left) / r.width) * W;
      const t = t0 + ((px - PAD.l) / iw) * (t1 - t0);
      let i = Math.round((t - t0) / current.timeline.bucketMs);
      i = Math.max(0, Math.min(pts.length - 1, i));
      const p = pts[i];
      const xp = PAD.l + (t1 === t0 ? 0 : ((p.t - t0) / (t1 - t0)) * iw);
      xh.setAttribute('x1', xp); xh.setAttribute('x2', xp); xh.setAttribute('visibility', 'visible');
      const rows = spec.series.slice().reverse().map(s => `<div><i style="background:${s.color}"></i>${esc(s.name)} <b>${p.count || s.key === 'tput' || s.key === 'errors' ? esc(spec.fmt(p[s.key])) : 'no samples'}</b></div>`).join('');
      tip.innerHTML = `<div>+${clock(p.t - current.start)} · ${fmtNum(p.count)} samples</div>${rows}${spec.extra ? `<div>${esc(spec.extra(p))}</div>` : ''}`;
      tip.hidden = false;
      const fr = fig.getBoundingClientRect();
      const left = (xp / W) * r.width + (r.left - fr.left);
      const tw = tip.offsetWidth;
      tip.style.left = Math.max(4, Math.min(fr.width - tw - 4, left + 12 > fr.width - tw ? left - tw - 12 : left + 12)) + 'px';
      tip.style.top = '34px';
    }
    const hide = () => { tip.hidden = true; xh.setAttribute('visibility', 'hidden'); };
    svg.addEventListener('pointermove', e => at(e.clientX));
    svg.addEventListener('pointerdown', e => at(e.clientX));
    svg.addEventListener('pointerleave', hide);
  }

  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(drawCharts, 150); });
})();
