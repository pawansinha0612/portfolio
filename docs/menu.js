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

  // Presenter mode (present.js) for screen recording: pages with <body data-present>, the pages below, or ?present=1.
  const PRESENT_PAGES = ['/play/hold-the-line/', '/play/spot-the-bottleneck/', '/tools/llm-load-test/', '/tools/llm-capacity/', '/tools/jmeter-to-k6/'];
  if (document.body.hasAttribute('data-present') || PRESENT_PAGES.includes(location.pathname) || /[?&]present=1/.test(location.search)) {
    const p = document.createElement('script');
    p.src = '/present.js';
    document.body.appendChild(p);
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
// Site search: a Search button in the header (and "/" or Ctrl/Cmd+K) opens /search/search.js's dialog.
(() => {
  const nav = document.querySelector('.nav nav');
  if (!nav || document.body.dataset.search === 'off') return;
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/search/search.css';
  document.head.appendChild(css);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ss-btn';
  btn.setAttribute('aria-label', 'Search the site');
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><span class="ss-lbl">Search</span><kbd>/</kbd>';
  nav.insertBefore(btn, nav.firstChild);
  let pending = null;
  const open = () => {
    if (window.SiteSearch) return window.SiteSearch.open();
    if (!pending) {
      pending = document.createElement('script');
      pending.src = '/search/search.js';
      pending.onload = () => window.SiteSearch.open();
      document.head.appendChild(pending);
    }
  };
  btn.addEventListener('click', open);
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if ((e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
      e.preventDefault();
      open();
    }
  });
})();
// Video slots (footer channel links, "Watch the video" cards): /videos/site.js reads /videos/videos.json and social.json.
(() => {
  if (document.body.dataset.videos === 'off') return;
  const s = document.createElement('script');
  s.src = '/videos/site.js';
  s.defer = true;
  document.head.appendChild(s);
})();
