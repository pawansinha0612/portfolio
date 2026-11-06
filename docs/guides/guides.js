// Guides: Copy buttons on code blocks, and wide tables scroll sideways on phones.
(function () {
  document.querySelectorAll('pre.ex-code').forEach(function (pre) {
    if (pre.closest('.g-codewrap')) return;
    var wrap = document.createElement('div');
    wrap.className = 'g-codewrap';
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'g-copy'; b.textContent = 'Copy';
    b.addEventListener('click', function () {
      var text = pre.innerText;
      var done = function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1500); };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () {});
    });
    wrap.appendChild(b);
  });
  document.querySelectorAll('table.g-table').forEach(function (t) {
    if (t.parentNode.classList.contains('g-tablewrap')) return;
    var w = document.createElement('div');
    w.className = 'g-tablewrap';
    t.parentNode.insertBefore(w, t);
    w.appendChild(t);
  });
})();
