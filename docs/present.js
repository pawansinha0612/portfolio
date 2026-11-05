// Presenter mode for screen recording: hides the header, footer, chat and calls to action, enlarges the page and
// fits it to a 16:9 recording. Turn on with ?present=1 or the "Presenter mode" button; Esc or the button turns it off.
// menu.js loads this file on pages that have <body data-present> or are listed in its PRESENT_PAGES.
(() => {
  if (window.__present) return;
  window.__present = true;
  const root = document.documentElement;
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/present.css';
  document.head.appendChild(css);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'present-toggle';
  btn.dataset.track = 'presenter-mode';
  document.body.appendChild(btn);

  const set = (on, push) => {
    root.classList.toggle('present', on);
    btn.textContent = on ? '✕' : '▶';
    btn.title = on ? 'Exit presenter mode (Esc)' : 'Presenter mode (for screen recording)';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', String(on));
    if (push) {
      const u = new URL(location.href);
      if (on) u.searchParams.set('present', '1'); else u.searchParams.delete('present');
      history.replaceState(null, '', u);
    }
    window.dispatchEvent(new Event('resize')); // let canvases and charts re-measure
  };
  btn.addEventListener('click', () => set(!root.classList.contains('present'), true));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root.classList.contains('present')) set(false, true);
  });
  set(new URLSearchParams(location.search).get('present') === '1', false);
})();
