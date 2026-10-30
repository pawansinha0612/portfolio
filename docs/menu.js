// Site header menu: the phone-size toggle, plus the footer year.
(() => {
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
