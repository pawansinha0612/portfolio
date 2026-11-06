// /guides/start/: tick-off learning path. Progress is kept in localStorage when it's available; the page works without it.
(function () {
  var KEY = 'guides-start-v1';
  var state = {};
  var canSave = true;
  try {
    state = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch (e) {
    state = {};
    canSave = false;
  }

  var boxes = Array.prototype.slice.call(document.querySelectorAll('.lp-item input[type=checkbox][data-id]'));
  if (!boxes.length) return;
  var count = document.getElementById('lp-count');
  var bar = document.getElementById('lp-bar');
  var next = document.getElementById('lp-next');
  var reset = document.getElementById('lp-reset');
  var saved = document.getElementById('lp-saved');

  function save() {
    if (!canSave) return;
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { canSave = false; showSaved(); }
  }

  function showSaved() {
    if (saved && !canSave) saved.textContent = 'Your browser is blocking storage, so ticks will be lost when you leave this page.';
  }

  function update() {
    var done = 0, firstOpen = null;
    boxes.forEach(function (b) {
      var item = b.closest('.lp-item');
      if (item) item.classList.toggle('is-done', b.checked);
      if (b.checked) done++;
      else if (!firstOpen) firstOpen = b;
    });
    var pct = Math.round(done / boxes.length * 100);
    count.textContent = done === 0 ? 'Tick items as you finish them.' :
      done + ' of ' + boxes.length + ' steps done (' + pct + '%).';
    bar.style.width = pct + '%';
    bar.parentNode.setAttribute('aria-valuenow', String(pct));
    reset.hidden = done === 0;

    next.textContent = '';
    if (firstOpen) {
      var link = firstOpen.closest('.lp-item').querySelector('a');
      if (done > 0 && link) {
        next.appendChild(document.createTextNode('Up next: '));
        var a = document.createElement('a');
        a.href = link.getAttribute('href');
        a.textContent = link.textContent;
        next.appendChild(a);
      }
    } else {
      next.textContent = 'All done. You have covered the whole path.';
    }

    document.querySelectorAll('.lp-stage').forEach(function (sec) {
      var inSec = sec.querySelectorAll('.lp-item input[type=checkbox][data-id]');
      var n = 0;
      inSec.forEach(function (b) { if (b.checked) n++; });
      var label = sec.querySelector('.lp-stage-count');
      var all = n === inSec.length;
      if (label) {
        label.textContent = n + ' of ' + inSec.length + (all ? ' · done' : '');
        label.classList.toggle('done', all);
      }
      var chip = document.querySelector('#lp-stages a[data-stage="' + sec.getAttribute('data-stage') + '"]');
      if (chip) chip.classList.toggle('done', all);
    });
  }

  boxes.forEach(function (b) {
    var id = b.getAttribute('data-id');
    if (state[id]) b.checked = true;
    b.addEventListener('change', function () {
      if (b.checked) state[id] = 1; else delete state[id];
      save();
      update();
    });
  });

  reset.addEventListener('click', function () {
    if (!window.confirm('Clear all ticks on this learning path?')) return;
    state = {};
    boxes.forEach(function (b) { b.checked = false; });
    save();
    update();
  });

  showSaved();
  update();
})();
