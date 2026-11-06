// Site search. menu.js loads this on the first click of the header's Search button (or "/" / Ctrl+K).
// The index (/search/index.json) is built by search/build.py. Everything runs in the browser.
(function () {
  if (window.SiteSearch) return;
  var INDEX_URL = '/search/index.json';
  var data = null, loading = null;

  function load() {
    if (data) return Promise.resolve(data);
    if (!loading) {
      loading = fetch(INDEX_URL).then(function (r) { return r.json(); }).then(function (rows) {
        data = rows.map(function (e) {
          return { e: e, t: e.t.toLowerCase(), h: (e.h || []).join(' • ').toLowerCase(),
            d: (e.d || '').toLowerCase(), x: (e.x || '').toLowerCase(), s: e.s.toLowerCase() };
        });
        return data;
      });
    }
    return loading;
  }

  function terms(q) {
    return q.toLowerCase().replace(/[^a-z0-9+#.\-\s]/g, ' ').split(/\s+/)
      .map(function (t) { return t.replace(/^[.\-]+|[.\-]+$/g, ''); })
      .filter(function (t) { return t.length > 1 || /\d/.test(t); });
  }
  function esc(s) { return s.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function reEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function wordRe(t) { return new RegExp('(^|[^a-z0-9])' + reEsc(t) + '($|[^a-z0-9])'); }

  function scoreField(text, t, wre, word, part) {
    if (!text) return 0;
    if (wre.test(text)) return word;
    return text.indexOf(t) >= 0 ? part : 0;
  }

  function search(q, limit) {
    var ts = terms(q);
    if (!ts.length || !data) return [];
    var phrase = ts.join(' ');
    var res = [];
    var mode = 'and';
    for (var pass = 0; pass < 2 && !res.length; pass++) {
      data.forEach(function (r) {
        var total = 0, matched = 0;
        ts.forEach(function (t) {
          var wre = wordRe(t);
          var s = scoreField(r.t, t, wre, 12, 6) + scoreField(r.h, t, wre, 5, 2) + scoreField(r.d, t, wre, 4, 2)
            + scoreField(r.s, t, wre, 2, 0) + scoreField(r.x, t, wre, 2, 1);
          if (s) matched++;
          total += s;
        });
        if (!matched || (mode === 'and' && matched < ts.length)) return;
        if (ts.length > 1 && r.t.indexOf(phrase) >= 0) total += 15;
        if (r.t === phrase) total += 20;
        if (r.e.s === 'Guide' || r.e.s === 'Tool') total += 1;
        res.push({ r: r, score: total * (matched / ts.length) });
      });
      mode = 'or';
    }
    res.sort(function (a, b) { return b.score - a.score; });
    return res.slice(0, limit || 30).map(function (x) { return { e: x.r.e, snippet: snippet(x.r, ts) }; });
  }

  function snippet(r, ts) {
    var src = r.e.d || '', low = r.d;
    var hit = ts.some(function (t) { return low.indexOf(t) >= 0; });
    if (!hit) {
      var pos = -1;
      ts.some(function (t) { pos = r.x.indexOf(t); return pos >= 0; });
      if (pos >= 0) {
        var start = Math.max(0, pos - 60);
        src = (start ? '…' : '') + r.e.x.slice(start, start + 170).trim() + '…';
      }
    }
    var out = esc(src.length > 200 ? src.slice(0, 197) + '…' : src);
    ts.forEach(function (t) {
      if (t.length < 2) return;
      out = out.replace(new RegExp('(' + reEsc(esc(t)) + ')', 'gi'), '<mark>$1</mark>');
    });
    return out;
  }

  function render(list, results, q) {
    if (!q.trim()) { list.innerHTML = ''; return; }
    if (!results.length) {
      list.innerHTML = '<li class="ss-empty">No pages match “' + esc(q) + '”. Try a shorter word, or <a href="/?need=Performance%20testing#contact">ask me directly</a>.</li>';
      return;
    }
    list.innerHTML = results.map(function (x, i) {
      return '<li><a class="ss-hit" href="' + esc(x.e.u) + '" data-i="' + i + '"><span class="ss-sec">' + esc(x.e.s) + '</span>' +
        '<span class="ss-title">' + esc(x.e.t) + '</span><span class="ss-snip">' + x.snippet + '</span></a></li>';
    }).join('');
  }

  // Wire an input + list (used by the dialog and the /search/ page).
  function wire(input, list, opts) {
    var timer;
    var run = function () {
      var q = input.value;
      load().then(function () {
        render(list, search(q, opts.limit), q);
        if (opts.onRender) opts.onRender(q);
      }, function () { list.innerHTML = '<li class="ss-empty">Search is unavailable right now.</li>'; });
    };
    input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(run, 90); });
    input.addEventListener('keydown', function (e) {
      var links = list.querySelectorAll('a.ss-hit');
      if (!links.length) return;
      var cur = list.querySelector('a.ss-hit.active');
      var i = cur ? +cur.dataset.i : -1;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        i = e.key === 'ArrowDown' ? Math.min(links.length - 1, i + 1) : Math.max(0, i - 1);
        if (cur) cur.classList.remove('active');
        links[i].classList.add('active');
        links[i].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        (cur || links[0]).click();
      }
    });
    return run;
  }

  var dialog = null;
  function open(q) {
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'ss-dialog';
      dialog.setAttribute('aria-label', 'Search the site');
      dialog.innerHTML = '<div class="ss-box"><div class="ss-bar">' +
        '<input class="ss-input" type="search" placeholder="Search guides, tools, glossary…" aria-label="Search" autocomplete="off" spellcheck="false">' +
        '<button type="button" class="ss-close" aria-label="Close search">Esc</button></div>' +
        '<ul class="ss-list" role="list"></ul>' +
        '<p class="ss-foot"><a class="ss-all" href="/search/">All results</a> · ↑↓ to move, Enter to open</p></div>';
      document.body.appendChild(dialog);
      var input = dialog.querySelector('.ss-input'), list = dialog.querySelector('.ss-list'), all = dialog.querySelector('.ss-all');
      wire(input, list, { limit: 8, onRender: function (v) { all.href = '/search/?q=' + encodeURIComponent(v); } });
      dialog.querySelector('.ss-close').addEventListener('click', function () { dialog.close(); });
      dialog.addEventListener('click', function (e) { if (e.target === dialog) dialog.close(); });
      list.addEventListener('click', function (e) { if (e.target.closest('a')) dialog.close(); });
    }
    var inp = dialog.querySelector('.ss-input');
    if (typeof q === 'string') { inp.value = q; inp.dispatchEvent(new Event('input')); }
    if (dialog.showModal) { if (!dialog.open) dialog.showModal(); } else { location.href = '/search/'; return; }
    inp.focus();
    inp.select();
    load();
  }

  window.SiteSearch = { open: open, search: function (q, n) { return load().then(function () { return search(q, n); }); }, wire: wire, _terms: terms };
})();
