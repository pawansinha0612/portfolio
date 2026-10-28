// Soft glow that follows the mouse. Shared by every page; styles are .cursor-glow in styles.css.
(() => {
  if (!window.matchMedia('(pointer: fine)').matches || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let glow = document.querySelector('.cursor-glow');
  if (!glow) {
    glow = document.createElement('div');
    glow.className = 'cursor-glow';
    glow.setAttribute('aria-hidden', 'true');
    document.body.prepend(glow);
  }
  let gx = innerWidth / 2, gy = innerHeight / 2, tx = gx, ty = gy;
  window.addEventListener('mousemove', e => { tx = e.clientX; ty = e.clientY; glow.classList.add('on'); }, { passive: true });
  document.addEventListener('mouseleave', () => glow.classList.remove('on'));
  (function follow() {
    gx += (tx - gx) * 0.12; gy += (ty - gy) * 0.12;
    glow.style.transform = `translate(${gx}px, ${gy}px)`;
    requestAnimationFrame(follow);
  })();
})();
