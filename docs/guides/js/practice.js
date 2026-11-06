// /guides/practice/: tick-off progress for the hands-on exercises. Used on the hub and on every exercise page.
// Progress is kept in localStorage when it's available; the pages work without it.
(function () {
  var KEY = 'guides-practice-v1';
  var IDS = ['smoke', 'thresholds', 'ramp', 'open-closed', 'data', 'knee', 'slow-dependency', 'grafana', 'compare', 'jmeter'];
  var LINKS = {
    'smoke': ['/guides/practice/smoke-test/', '1. Your first smoke test'],
    'thresholds': ['/guides/practice/thresholds/', '2. Thresholds that fail the run'],
    'ramp': ['/guides/practice/ramp-up/', '3. Ramp up and read the summary'],
    'open-closed': ['/guides/practice/open-vs-closed/', '4. Open vs closed workload model'],
    'data': ['/guides/practice/test-data-and-correlation/', '5. Test data and correlation'],
    'knee': ['/guides/practice/find-the-knee/', '6. Find the knee'],
    'slow-dependency': ['/guides/practice/slow-dependency/', '7. Find the hidden slow dependency'],
    'grafana': ['/guides/practice/grafana/', '8. Watch it live in Grafana'],
    'compare': ['/guides/practice/compare-runs/', '9. Compare two runs'],
    'jmeter': ['/guides/practice/jmeter/', '10. The same test in JMeter']
  };
  var state = {};
  var canSave = true;

  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || '{}');
      state = s && typeof s === 'object' ? s : {};
    } catch (e) {
      state = {};
      canSave = false;
    }
  }

  function save() {
    if (!canSave) return;
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { canSave = false; showSaved(); }
  }

  var boxes = Array.prototype.slice.call(document.querySelectorAll('input[type=checkbox][data-practice]'));
  if (!boxes.length) return;
  var total = document.getElementById('pr-total');
  var bar = document.getElementById('pr-bar');
  var next = document.getElementById('pr-next');
  var reset = document.getElementById('pr-reset');
  var saved = document.getElementById('pr-saved');

  function showSaved() {
    if (saved && !canSave) saved.textContent = 'Your browser is blocking storage, so ticks will be lost when you leave this page.';
  }

  function doneCount() {
    var n = 0;
    IDS.forEach(function (id) { if (state[id]) n++; });
    return n;
  }

  function firstOpen() {
    for (var i = 0; i < IDS.length; i++) if (!state[IDS[i]]) return IDS[i];
    return null;
  }

  function link(id) {
    var a = document.createElement('a');
    a.href = LINKS[id][0];
    a.textContent = LINKS[id][1];
    return a;
  }

  function update() {
    var done = doneCount();
    var pct = Math.round(done / IDS.length * 100);
    var open = firstOpen();

    boxes.forEach(function (b) {
      var id = b.getAttribute('data-practice');
      b.checked = !!state[id];
      var item = b.closest('.pr-item, .pr-done');
      if (item) item.classList.toggle('is-done', b.checked);
    });

    // Hub page
    if (total) total.textContent = done === 0 ? 'Tick exercises as you finish them.' :
      done + ' of ' + IDS.length + ' exercises done (' + pct + '%).';
    if (bar) {
      bar.style.width = pct + '%';
      bar.parentNode.setAttribute('aria-valuenow', String(pct));
    }
    if (reset) reset.hidden = done === 0;
    if (next) {
      next.textContent = '';
      if (!open) next.textContent = 'All ten done. Now write up Exercise 7 as a real finding.';
      else if (done > 0) { next.appendChild(document.createTextNode('Up next: ')); next.appendChild(link(open)); }
    }

    // Exercise pages
    document.querySelectorAll('.pr-done .pr-count').forEach(function (el) {
      el.textContent = '';
      el.appendChild(document.createTextNode(done + ' of ' + IDS.length + ' done · '));
      var hub = document.createElement('a');
      hub.href = '/guides/practice/';
      hub.textContent = 'all exercises';
      el.appendChild(hub);
    });
  }

  load();
  boxes.forEach(function (b) {
    b.addEventListener('change', function () {
      var id = b.getAttribute('data-practice');
      if (b.checked) state[id] = 1; else delete state[id];
      save();
      update();
    });
  });

  if (reset) reset.addEventListener('click', function () {
    if (!window.confirm('Clear all ticks for the practice exercises?')) return;
    state = {};
    save();
    update();
  });

  // Keep other open tabs in step
  window.addEventListener('storage', function (e) {
    if (e.key === KEY) { load(); update(); }
  });

  showSaved();
  update();
})();
