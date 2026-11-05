// /explain/ai-prompts-for-testers/ — copy buttons and category filter.
(() => {
  'use strict';
  document.querySelectorAll('.prompt').forEach((card) => {
    const btn = card.querySelector('[data-copy]');
    const pre = card.querySelector('pre');
    if (btn && pre) window.ExSvg.copyButton(btn, () => pre.textContent);
  });
  const cards = Array.from(document.querySelectorAll('.prompt'));
  document.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    const f = b.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    cards.forEach((c) => { c.hidden = !(f === 'all' || c.dataset.cat.split(' ').includes(f)); });
  }));
})();
