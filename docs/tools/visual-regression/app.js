/* UI for /tools/visual-regression/. Logic lives in vr.js (window.VisualRegression); pixel diffs run in worker.js.
   Screenshots are decoded and compared in this browser tab. Nothing is uploaded. */
(function () {
  'use strict';
  const VR = window.VisualRegression;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = x => Number(x).toLocaleString('en-AU');
  const MAX_PIXELS = 40e6;
  const sets = { base: [], next: [] };
  let pairsInfo = null, rows = [], current = -1, globalRegions = [], running = false, mode = 'side';

  // ------------------------------------------------------------------ choosing files
  const IMG = /\.(png|jpe?g|webp|gif|bmp)$/i;
  function addFiles(which, list, fromFolder) {
    const items = Array.from(list).filter(f => IMG.test(f.name) || /^image\//.test(f.type)).map(f => ({ file: f, name: f.name, path: f.webkitRelativePath || f.name, fromFolder: !!(fromFolder && f.webkitRelativePath) }));
    sets[which] = sets[which].concat(items);
    drawSet(which);
  }
  function drawSet(which) {
    const n = sets[which].length;
    $(which + '-count').textContent = n ? num(n) + ' screenshot' + (n > 1 ? 's' : '') : 'No screenshots yet';
    $(which + '-list').innerHTML = sets[which].slice(0, 6).map(i => '<li>' + esc(i.path) + '</li>').join('') + (n > 6 ? '<li>and ' + (n - 6) + ' more</li>' : '');
  }
  ['base', 'next'].forEach(w => {
    $(w + '-files').addEventListener('change', e => { addFiles(w, e.target.files, false); e.target.value = ''; });
    $(w + '-dir').addEventListener('change', e => { addFiles(w, e.target.files, true); e.target.value = ''; });
    const zone = $(w + '-zone');
    ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove('over'); }));
    zone.addEventListener('drop', e => { if (e.dataTransfer && e.dataTransfer.files.length) addFiles(w, e.dataTransfer.files, false); });
    $(w + '-clear').addEventListener('click', () => { sets[w] = []; drawSet(w); });
  });

  // ------------------------------------------------------------------ sample screenshots, drawn on a canvas
  function drawShop(variant, w, h) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#1f2a44'; x.fillRect(0, 0, w, 64);
    x.fillStyle = '#ffffff'; x.font = 'bold 22px sans-serif'; x.fillText('Acme Shop', 24, 40);
    x.font = '15px sans-serif'; ['Shop', 'Deals', 'Help'].forEach((t, i) => x.fillText(t, w - 230 + i * 70, 40));
    x.fillStyle = '#eef2fb'; x.fillRect(0, 64, w, 220);
    x.fillStyle = '#1b2030'; x.font = 'bold 34px sans-serif';
    x.fillText(variant === 'text' ? 'Summer sale: 30% off' : 'Summer sale: 20% off', 24, 150);
    x.font = '16px sans-serif'; x.fillStyle = '#5b6476'; x.fillText('Free delivery on orders over $50 across Australia.', 24, 186);
    x.fillStyle = variant === 'button' ? '#0f8a5f' : '#2557d6';
    x.beginPath(); x.roundRect ? x.roundRect(24, 210, 150, 46, 10) : x.rect(24, 210, 150, 46); x.fill();
    x.fillStyle = '#fff'; x.font = 'bold 16px sans-serif'; x.fillText('Shop now', 60, 239);
    const top = variant === 'moved' ? 318 : 310;
    for (let i = 0; i < 3; i++) {
      const cx = 24 + i * ((w - 48) / 3);
      x.fillStyle = '#f6f7fb'; x.fillRect(cx, top, (w - 48) / 3 - 16, 200);
      x.fillStyle = ['#f3b04a', '#6cc3a0', '#e46a6a'][i]; x.fillRect(cx + 16, top + 16, (w - 48) / 3 - 48, 110);
      x.fillStyle = '#1b2030'; x.font = '15px sans-serif'; x.fillText(['Sun hat', 'Beach towel', 'Water bottle'][i], cx + 16, top + 150);
      x.fillStyle = '#2557d6'; x.font = 'bold 15px sans-serif'; x.fillText(['$24', '$39', '$18'][i], cx + 16, top + 176);
    }
    x.fillStyle = '#5b6476'; x.font = '13px sans-serif';
    x.fillText('Updated ' + (variant === 'clock' ? '10:42:19' : '10:41:03'), w - 160, h - 20);
    return new Promise(res => c.toBlob(b => res(b), 'image/png'));
  }
  async function loadSample() {
    const spec = [['home-desktop.png', 1000, 620, '', 'clock'], ['deals-desktop.png', 1000, 620, '', 'button'], ['product-desktop.png', 1000, 620, '', 'moved'],
      ['home-mobile.png', 380, 620, '', ''], ['checkout-desktop.png', 1000, 620, '', 'text']];
    sets.base = []; sets.next = [];
    for (const [name, w, h, a, b] of spec) {
      sets.base.push({ file: await drawShop(a, w, h), name, path: 'baseline/' + name, fromFolder: true });
      sets.next.push({ file: await drawShop(b, w, name.startsWith('checkout') ? h + 40 : h), name, path: 'new/' + name, fromFolder: true });
    }
    sets.base.push({ file: await drawShop('', 1000, 620), name: 'about-desktop.png', path: 'baseline/about-desktop.png', fromFolder: true });
    drawSet('base'); drawSet('next');
    globalRegions = [];
    await runAll();
  }
  $('sample').addEventListener('click', loadSample);

  // ------------------------------------------------------------------ decoding and diffing
  async function decode(item) {
    if (item.img) return item.img;
    let bmp;
    try { bmp = await createImageBitmap(item.file); }
    catch (e) { throw new Error(item.name + ' could not be read as an image.'); }
    if (bmp.width * bmp.height > MAX_PIXELS) throw new Error(item.name + ' is too large (' + bmp.width + '×' + bmp.height + ').');
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    item.img = ctx.getImageData(0, 0, c.width, c.height);
    return item.img;
  }
  let worker = null, seq = 0;
  const pending = new Map();
  function getWorker() {
    if (worker === false) return null;
    if (!worker) {
      try {
        worker = new Worker('/tools/visual-regression/worker.js');
        worker.onmessage = e => { const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id); if (e.data.ok) { e.data.result.output = new Uint8ClampedArray(e.data.buffer); p.resolve(e.data.result); } else p.reject(new Error(e.data.error)); };
        worker.onerror = () => { worker = false; pending.forEach(p => p.fallback()); pending.clear(); };
      } catch (e) { worker = false; return null; }
    }
    return worker;
  }
  function diff(a, b, opts) {
    const w = getWorker();
    const local = () => VR.diffImages(a, b, opts);
    if (!w) return Promise.resolve().then(local);
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject, fallback: () => { try { resolve(local()); } catch (e) { reject(e); } } });
      const ab = a.data.slice().buffer, bb = b.data.slice().buffer;
      w.postMessage({ id, a: { width: a.width, height: a.height, buffer: ab }, b: { width: b.width, height: b.height, buffer: bb }, opts }, [ab, bb]);
    });
  }
  function options() {
    return { threshold: clamp(+$('o-thr').value, 0, 1, 0.1), includeAA: !$('o-aa').checked, sizeMode: $('o-size').value, maxPct: clamp(+$('o-max').value, 0, 100, 0.1) };
  }
  const clamp = (v, lo, hi, d) => (isNaN(v) ? d : Math.max(lo, Math.min(hi, v)));

  async function runAll() {
    if (running) return;
    $('err').hidden = true;
    if (!sets.base.length || !sets.next.length) { showErr('Add baseline and new screenshots first, or try the sample.'); return; }
    pairsInfo = VR.pairFiles(sets.base, sets.next);
    if (!pairsInfo.pairs.length) { showErr('No screenshots share a name between the two sets. Files are paired by folder and file name, for example home-desktop.png in both.'); return; }
    running = true;
    $('go').disabled = true;
    rows = pairsInfo.pairs.map(p => ({ pair: p, name: p.next.path && p.next.fromFolder ? p.next.path.slice(p.next.path.indexOf('/') + 1) : p.next.name, regions: [], r: null, status: 'pending', error: '' }));
    current = -1;
    renderResults();
    try {
      for (let i = 0; i < rows.length; i++) {
        $('progress').textContent = 'Comparing ' + (i + 1) + ' of ' + rows.length + '…';
        await diffRow(rows[i]);
        renderTable();
      }
      $('progress').textContent = '';
      const firstFail = rows.findIndex(r => r.status === 'fail');
      openRow(firstFail >= 0 ? firstFail : 0);
    } finally { running = false; $('go').disabled = false; }
  }
  async function diffRow(row) {
    const o = options();
    try {
      const a = await decode(row.pair.base), b = await decode(row.pair.next);
      row.r = await diff(a, b, { threshold: o.threshold, includeAA: o.includeAA, sizeMode: o.sizeMode, ignore: globalRegions.concat(row.regions) });
      row.status = VR.verdict(row.r, o.maxPct);
      row.error = '';
    } catch (e) { row.status = 'error'; row.error = e.message; row.r = null; }
  }
  async function rediffAll() { for (const r of rows) await diffRow(r); renderTable(); if (current >= 0) drawViewer(); }
  ['o-thr', 'o-aa', 'o-size', 'o-max'].forEach(id => $(id).addEventListener('change', () => { if (rows.length && !running) rediffAll(); }));
  $('go').addEventListener('click', runAll);
  function showErr(m) { $('err').textContent = m; $('err').hidden = false; }

  // ------------------------------------------------------------------ results
  const LABEL = { same: 'Identical', pass: 'Within threshold', fail: 'Changed', error: 'Error', pending: '…' };
  function renderResults() {
    $('result').hidden = false;
    $('result').innerHTML = '<div class="verdict" id="vr-verdict"></div>'
      + '<div class="block"><div class="block-head"><h3>Screenshots</h3><div class="exports"><button class="btn btn-small" type="button" id="x-report">Download HTML report</button></div></div>'
      + '<p class="hint" id="progress" aria-live="polite"></p><div class="tbl-wrap"><table class="data" id="vr-table"></table></div><div id="vr-extra"></div></div>'
      + '<div class="block" id="viewer" hidden></div>';
    $('x-report').addEventListener('click', downloadReport);
    renderTable();
  }
  function renderTable() {
    const o = options();
    const fails = rows.filter(r => r.status === 'fail').length, errs = rows.filter(r => r.status === 'error').length, done = rows.filter(r => r.status !== 'pending').length;
    const v = $('vr-verdict');
    if (v) {
      const cls = fails || errs ? 'fail' : done < rows.length ? '' : 'pass';
      v.className = 'verdict ' + cls;
      v.innerHTML = '<h2>' + (done < rows.length ? 'Comparing…' : fails ? fails + ' of ' + rows.length + ' screenshots changed' : errs ? 'Some screenshots could not be compared' : 'No visual changes over ' + o.maxPct + '%') + '</h2>'
        + '<p>' + rows.length + ' pairs compared · ' + rows.filter(r => r.status === 'same').length + ' identical · ' + rows.filter(r => r.status === 'pass').length + ' within threshold · ' + fails + ' changed'
        + (pairsInfo.onlyBase.length ? ' · ' + pairsInfo.onlyBase.length + ' missing in the new build' : '') + (pairsInfo.onlyNew.length ? ' · ' + pairsInfo.onlyNew.length + ' new, with no baseline' : '') + '</p>';
    }
    $('vr-table').innerHTML = '<thead><tr><th class="l">Screenshot</th><th>Size</th><th>Changed</th><th>Pixels</th><th class="l">Result</th><th></th></tr></thead><tbody>'
      + rows.map((r, i) => '<tr class="' + (i === current ? 'sel' : '') + '"><td>' + esc(r.name) + '</td><td>' + (r.r ? r.r.sizeA.join('×') + (r.r.sizeMismatch ? ' → ' + r.r.sizeB.join('×') : '') : '–') + '</td><td>'
        + (r.r ? r.r.changePct.toFixed(3) + '%' : '–') + '</td><td>' + (r.r ? num(r.r.diffPixels) : '–') + '</td><td class="l"><span class="vr-st ' + r.status + '">' + LABEL[r.status] + '</span>' + (r.error ? ' <small>' + esc(r.error) + '</small>' : '')
        + (r.r && r.r.sizeMismatch ? ' <small>size changed</small>' : '') + '</td><td><button class="lnk" type="button" data-open="' + i + '"' + (r.r ? '' : ' disabled') + '>View</button></td></tr>').join('') + '</tbody>';
    $('vr-extra').innerHTML = (pairsInfo.onlyBase.length ? '<p class="hint"><b>Missing in the new build:</b> ' + esc(pairsInfo.onlyBase.map(f => f.path).join(', ')) + '</p>' : '')
      + (pairsInfo.onlyNew.length ? '<p class="hint"><b>New, with no baseline:</b> ' + esc(pairsInfo.onlyNew.map(f => f.path).join(', ')) + '</p>' : '');
  }
  document.addEventListener('click', e => { const b = e.target.closest('[data-open]'); if (b) openRow(+b.dataset.open, true); });

  // ------------------------------------------------------------------ viewer
  let drawMode = false, drag = null;
  function openRow(i, scroll) {
    if (!rows[i] || !rows[i].r) return;
    current = i;
    renderTable();
    const v = $('viewer');
    v.hidden = false;
    v.innerHTML = '<div class="block-head"><h3 id="v-title"></h3><div class="exports"><button class="lnk" type="button" id="v-prev">← Previous</button><button class="lnk" type="button" id="v-next">Next →</button></div></div>'
      + '<div class="modes" role="tablist" aria-label="View">' + [['side', 'Side by side'], ['overlay', 'Overlay'], ['slider', 'Slider'], ['diff', 'Differences only']].map(m => '<button class="chip-btn" type="button" role="tab" data-mode="' + m[0] + '" aria-selected="' + (m[0] === mode) + '">' + m[1] + '</button>').join('') + '</div>'
      + '<div class="v-tools"><label class="field" id="v-op-l">Opacity <input type="range" id="v-op" min="0" max="100" value="50"></label><label class="field" id="v-sl-l">Position <input type="range" id="v-sl" min="0" max="100" value="50"></label>'
      + '<button class="chip-btn" type="button" id="v-draw" aria-pressed="false">Draw ignore area</button><label class="field"><input type="checkbox" id="v-global"> apply to every screenshot</label><button class="lnk" type="button" id="v-clear">Clear ignore areas</button></div>'
      + '<p class="hint" id="v-hint"></p><div id="stage" class="stage"></div>';
    v.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { mode = b.dataset.mode; v.querySelectorAll('[data-mode]').forEach(x => x.setAttribute('aria-selected', String(x === b))); drawViewer(); }));
    $('v-prev').addEventListener('click', () => step(-1));
    $('v-next').addEventListener('click', () => step(1));
    $('v-op').addEventListener('input', drawViewer);
    $('v-sl').addEventListener('input', drawViewer);
    $('v-draw').addEventListener('click', () => { drawMode = !drawMode; $('v-draw').setAttribute('aria-pressed', String(drawMode)); $('stage').classList.toggle('drawing', drawMode); });
    $('v-clear').addEventListener('click', async () => { rows[current].regions = []; if ($('v-global').checked) { globalRegions = []; await rediffAll(); } else { await diffRow(rows[current]); renderTable(); drawViewer(); } });
    drawViewer();
    if (scroll) v.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function step(d) { for (let i = current + d; i >= 0 && i < rows.length; i += d) if (rows[i].r) { openRow(i); return; } }

  function canvasFrom(img, w, h) {
    const c = document.createElement('canvas'); c.width = w || img.width; c.height = h || img.height;
    const ctx = c.getContext('2d');
    if (img instanceof ImageData) ctx.putImageData(img, 0, 0); else ctx.drawImage(img, 0, 0);
    return c;
  }
  function regionsFor(row) { return globalRegions.concat(row.regions); }
  function outline(c, row, temp) {
    const ctx = c.getContext('2d');
    ctx.save(); ctx.lineWidth = Math.max(2, c.width / 400); ctx.strokeStyle = '#2f6bff'; ctx.fillStyle = 'rgba(47,107,255,.15)';
    regionsFor(row).concat(temp ? [temp] : []).map(VR.normRect).forEach(r => { ctx.fillRect(r.x, r.y, r.w, r.h); ctx.strokeRect(r.x, r.y, r.w, r.h); });
    if (row.r && row.r.bbox && !temp) { const b = row.r.bbox; ctx.setLineDash([8, 6]); ctx.strokeStyle = '#e11d48'; ctx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8); }
    ctx.restore();
  }
  function drawViewer(temp) {
    const row = rows[current];
    if (!row || !row.r) return;
    const r = row.r, a = row.pair.base.img, b = row.pair.next.img;
    $('v-title').textContent = row.name + ' · ' + r.changePct.toFixed(3) + '% changed';
    $('v-op-l').hidden = mode !== 'overlay';
    $('v-sl-l').hidden = mode !== 'slider';
    $('v-hint').textContent = (r.sizeMismatch ? 'Sizes differ: baseline ' + r.sizeA.join('×') + ', new ' + r.sizeB.join('×') + '. ' : '')
      + (mode === 'diff' ? 'Red: changed. Yellow: anti-aliasing (ignored). Blue: ignore areas.' : 'Dashed red box: where the changes are.') + (drawMode ? ' Drag on an image to add an ignore area.' : '');
    const st = $('stage');
    const diffImg = new ImageData(new Uint8ClampedArray(r.output), r.width, r.height);
    let html;
    if (mode === 'side') {
      st.className = 'stage side' + (drawMode ? ' drawing' : '');
      st.innerHTML = '<figure><figcaption>Baseline</figcaption><div class="cv" data-c="a"></div></figure><figure><figcaption>New</figcaption><div class="cv" data-c="b"></div></figure><figure><figcaption>Differences</figcaption><div class="cv" data-c="d"></div></figure>';
      const ca = canvasFrom(a), cb = canvasFrom(b), cd = canvasFrom(diffImg);
      [ca, cb, cd].forEach(c => outline(c, row, temp));
      st.querySelector('[data-c=a]').appendChild(ca); st.querySelector('[data-c=b]').appendChild(cb); st.querySelector('[data-c=d]').appendChild(cd);
    } else if (mode === 'diff') {
      st.className = 'stage single' + (drawMode ? ' drawing' : '');
      st.innerHTML = '<div class="cv"></div>';
      const cd = canvasFrom(diffImg); outline(cd, row, temp); st.firstChild.appendChild(cd);
    } else {
      st.className = 'stage single' + (drawMode ? ' drawing' : '');
      const w = r.width, h = r.height;
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      const ca = canvasFrom(a), cb = canvasFrom(b);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      if (mode === 'overlay') { ctx.drawImage(ca, 0, 0); ctx.globalAlpha = +$('v-op').value / 100; ctx.drawImage(cb, 0, 0); ctx.globalAlpha = 1; }
      else {
        const sx = Math.round(w * +$('v-sl').value / 100);
        ctx.drawImage(ca, 0, 0);
        ctx.save(); ctx.beginPath(); ctx.rect(sx, 0, w - sx, h); ctx.clip(); ctx.drawImage(cb, 0, 0); ctx.restore();
        ctx.fillStyle = '#e11d48'; ctx.fillRect(sx - 1, 0, 2, h);
      }
      outline(c, row, temp);
      html = '<div class="cv"></div>' + (mode === 'slider' ? '<p class="hint">Left of the line: baseline. Right: new build.</p>' : '');
      st.innerHTML = html; st.firstChild.appendChild(c);
    }
    st.querySelectorAll('canvas').forEach(bindDraw);
  }
  function bindDraw(c) {
    const pt = e => { const b = c.getBoundingClientRect(); return { x: (e.clientX - b.left) * c.width / b.width, y: (e.clientY - b.top) * c.height / b.height }; };
    let snap = null;
    c.addEventListener('pointerdown', e => { if (!drawMode) return; e.preventDefault(); c.setPointerCapture(e.pointerId); const p = pt(e); drag = { x: p.x, y: p.y, w: 0, h: 0 }; snap = c.getContext('2d').getImageData(0, 0, c.width, c.height); });
    c.addEventListener('pointermove', e => { if (!drawMode || !drag) return; const p = pt(e); drag.w = p.x - drag.x; drag.h = p.y - drag.y; const ctx = c.getContext('2d'); if (snap) ctx.putImageData(snap, 0, 0); ctx.save(); ctx.strokeStyle = '#2f6bff'; ctx.lineWidth = Math.max(2, c.width / 400); const n = VR.normRect(drag); ctx.strokeRect(n.x, n.y, n.w, n.h); ctx.restore(); });
    c.addEventListener('pointerup', async () => {
      if (!drawMode || !drag) return;
      const rct = VR.normRect(drag); drag = null; snap = null;
      if (rct.w < 3 || rct.h < 3) { drawViewer(); return; }
      if ($('v-global').checked) { globalRegions.push(rct); await rediffAll(); }
      else { rows[current].regions.push(rct); await diffRow(rows[current]); renderTable(); drawViewer(); }
    });
  }

  // ------------------------------------------------------------------ report
  function thumb(img, maxW, type) {
    const src = img instanceof ImageData ? canvasFrom(img) : img;
    const s = Math.min(1, maxW / src.width);
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(src.width * s)); c.height = Math.max(1, Math.round(src.height * s));
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL(type || 'image/jpeg', 0.82);
  }
  function downloadReport() {
    const o = options();
    const items = rows.filter(r => r.r).map(r => ({ name: r.name, status: r.status, changePct: r.r.changePct, diffPixels: r.r.diffPixels,
      sizeNote: r.r.sizeMismatch ? 'size ' + r.r.sizeA.join('×') + ' → ' + r.r.sizeB.join('×') : '',
      baseThumb: thumb(r.pair.base.img, 520), newThumb: thumb(r.pair.next.img, 520), diffThumb: thumb(new ImageData(new Uint8ClampedArray(r.r.output), r.r.width, r.r.height), 520, 'image/png') }));
    items.sort((x, y) => (y.status === 'fail') - (x.status === 'fail') || y.changePct - x.changePct);
    const html = VR.reportHTML({ items, date: new Date().toLocaleString('en-AU'), maxPct: o.maxPct, threshold: o.threshold, onlyBase: pairsInfo.onlyBase.map(f => f.path), onlyNew: pairsInfo.onlyNew.map(f => f.path) });
    download('visual-regression-report.html', html, 'text/html');
  }
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: (type || 'text/plain') + ';charset=utf-8' }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ------------------------------------------------------------------ CI generator
  let gen = null, genFile = 0;
  function generate() {
    $('g-err').hidden = true;
    try {
      gen = VR.generateCI({
        baseURL: $('g-url').value, pages: $('g-pages').value,
        viewports: Array.from(document.querySelectorAll('[name=g-vp]:checked')).map(x => x.value),
        browsers: Array.from(document.querySelectorAll('[name=g-br]:checked')).map(x => x.value),
        maxDiffPixelRatio: clamp(+$('g-ratio').value, 0, 100, 1) / 100, threshold: clamp(+$('g-thr').value, 0, 1, 0.1),
        fullPage: $('g-full').checked, masks: $('g-mask').value, hideSelectors: $('g-hide').value,
      });
    } catch (e) { $('g-err').textContent = e.message; $('g-err').hidden = false; $('g-out').hidden = true; return; }
    $('g-out').hidden = false;
    $('g-count').textContent = gen.pages.length + ' page' + (gen.pages.length > 1 ? 's' : '') + ' × ' + gen.viewports.length + ' screen size' + (gen.viewports.length > 1 ? 's' : '') + ' × ' + gen.browsers.length + ' browser' + (gen.browsers.length > 1 ? 's' : '') + ' = ' + gen.screenshots + ' screenshots per run.';
    $('g-tabs').innerHTML = gen.files.map((f, i) => '<button class="chip-btn" type="button" role="tab" data-f="' + i + '" aria-selected="' + (i === genFile) + '">' + esc(f.name) + '</button>').join('');
    showFile();
  }
  function showFile() { $('g-code').textContent = gen.files[genFile].content; $('g-tabs').querySelectorAll('[data-f]').forEach(b => b.setAttribute('aria-selected', String(+b.dataset.f === genFile))); }
  $('g-tabs').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (b) { genFile = +b.dataset.f; showFile(); } });
  $('g-go').addEventListener('click', generate);
  $('g-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(gen.files[genFile].content); $('g-copied').textContent = 'Copied'; }
    catch (e) { $('g-copied').textContent = 'Copy failed: use Download'; }
    setTimeout(() => { $('g-copied').textContent = ''; }, 2500);
  });
  $('g-dl').addEventListener('click', () => { const f = gen.files[genFile]; download(f.name.split('/').pop(), f.content, 'text/plain'); });
  generate();
})();
