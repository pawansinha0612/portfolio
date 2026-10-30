// Site header menu: the phone-size toggle, plus the footer year and analytics.
(() => {
  // Analytics (GoatCounter) on every page. data-goatcounter on <body> overrides the code; "off" disables it.
  // Clicks count as events: data-track names, plus email, booking and shop links (named with the page they're on).
  const gc = document.body.dataset.goatcounter || 'https://pawansinha.goatcounter.com/count';
  if (gc !== 'off') {
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://gc.zgo.at/count.js';
    s.dataset.goatcounter = gc.includes('://') ? gc : `https://${gc}.goatcounter.com/count`;
    document.head.appendChild(s);
    const count = (name) => window.goatcounter && window.goatcounter.count && window.goatcounter.count({ path: name, title: name, event: true });
    document.addEventListener('click', (e) => {
      const a = e.target.closest('[data-track], a[href]');
      if (!a) return;
      const href = a.getAttribute('href') || '';
      const kind = href.startsWith('mailto:') ? 'email' : /calendly\.com|calendar\.app\.google/.test(href) ? 'book-call'
        : /gumroad\.com/.test(href) ? 'buy' : '';
      if (a.dataset.track) count(a.dataset.track + (kind ? ' (' + kind + ')' : ''));
      else if (kind) count(kind + ' ' + location.pathname);
    });
  }

  const header = document.querySelector('.nav');
  const toggle = header && header.querySelector('.nav-toggle');
  document.querySelectorAll('[data-year]').forEach((el) => (el.textContent = new Date().getFullYear()));
  if (!toggle) return;

  const set = (open) => {
    header.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  };
  toggle.addEventListener('click', () => set(!header.classList.contains('open')));
  header.querySelectorAll('nav a').forEach((a) => a.addEventListener('click', () => set(false)));
  document.addEventListener('keydown', (e) => e.key === 'Escape' && set(false));
  document.addEventListener('click', (e) => !header.contains(e.target) && set(false));
  matchMedia('(min-width: 861px)').addEventListener('change', () => set(false));
})();
