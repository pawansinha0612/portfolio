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
// Questions under each guide (giscus = GitHub Discussions, category "Q&A" in pawansinha0612/portfolio).
// Only on guide articles (pages with TechArticle JSON-LD). Switch: GISCUS_ON. Needs the giscus GitHub app installed on the repo.
(function () {
  var GISCUS_ON = false;
  if (!GISCUS_ON) return;
  var ld = document.querySelector('script[type="application/ld+json"]');
  if (!ld || ld.textContent.indexOf('TechArticle') < 0) return;
  var main = document.querySelector('main');
  if (!main) return;
  var sec = document.createElement('section');
  sec.className = 'wrap ex-prose g-discuss';
  sec.id = 'questions';
  sec.innerHTML = '<h2>Questions about this guide</h2>' +
    '<p>Stuck on a step, or something didn\'t work in your version? Ask below with a free GitHub account. I answer questions here, and common ones become new guides.</p>' +
    '<div class="giscus"></div>';
  var end = main.querySelector('section.cta-end');
  main.insertBefore(sec, end || null);
  var s = document.createElement('script');
  s.src = 'https://giscus.app/client.js';
  s.async = true;
  s.crossOrigin = 'anonymous';
  var cfg = { repo: 'pawansinha0612/portfolio', 'repo-id': 'R_kgDOVSHDLQ', category: 'Q&A', 'category-id': 'DIC_kwDOVSHDLc4DKgmq',
    mapping: 'pathname', strict: '1', 'reactions-enabled': '1', 'emit-metadata': '0', 'input-position': 'top',
    theme: 'preferred_color_scheme', lang: 'en', loading: 'lazy' };
  Object.keys(cfg).forEach(function (k) { s.setAttribute('data-' + k, cfg[k]); });
  sec.querySelector('.giscus').appendChild(s);
})();
