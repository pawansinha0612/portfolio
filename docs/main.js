(() => {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  document.getElementById('year').textContent = new Date().getFullYear();

  // Availability badge
  const badge = document.getElementById('availability');
  const from = badge.dataset.availableFrom;
  if (from && new Date(from) > new Date()) {
    const d = new Date(from).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
    badge.textContent = 'Available from ' + d;
    badge.classList.add('later');
  }

  // Hide links and text that still hold a [placeholder], so the live site never shows them
  document.querySelectorAll('a[href^="["]').forEach(a => a.remove());
  document.querySelectorAll('.footer p').forEach(p => { if (p.textContent.includes('[')) p.remove(); });
  document.querySelectorAll('#testimonials .quote').forEach(q => { if (q.textContent.includes('[')) q.remove(); });
  const testimonials = document.getElementById('testimonials');
  if (testimonials && !testimonials.querySelector('.quote')) testimonials.remove();

  // Booking buttons: open the Calendly link when set, otherwise keep the pre-filled email
  const bookingUrl = document.body.dataset.bookingUrl;
  if (bookingUrl) {
    document.querySelectorAll('.js-book').forEach(a => {
      a.href = bookingUrl;
      a.target = '_blank';
      a.rel = 'noopener';
    });
  }

  // Email button: also copy the address, for visitors with no mail app set up
  document.querySelectorAll('.js-copy').forEach(a => {
    a.addEventListener('click', () => {
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(a.dataset.copy).then(() => {
        const label = a.textContent;
        a.textContent = 'Email copied ✓';
        setTimeout(() => { a.textContent = label; }, 2000);
      }).catch(() => {});
    });
  });

  // Nav shadow once the page scrolls
  const nav = document.querySelector('.nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  if (reduceMotion || !('IntersectionObserver' in window)) {
    document.documentElement.classList.remove('js');
    return;
  }

  // Scroll reveal: elements fade up as they enter the viewport, siblings staggered
  const groups = [
    '.section h2, .section .eyebrow, .section-lead',
    '.stats > div', '.grid > .card', '.cases > .case', '.steps > li',
    '.toolkit > div', '.ticks > li', '.contact-inner > *', '.trust .wrap > *',
  ];
  groups.forEach(sel => {
    document.querySelectorAll(sel).forEach(el => {
      el.classList.add('reveal');
      const i = Array.prototype.indexOf.call(el.parentElement.children, el);
      el.style.setProperty('--delay', `${Math.min(i, 6) * 80}ms`);
    });
  });
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      e.target.classList.add('in');
      io.unobserve(e.target);
      const num = e.target.querySelector('.num');
      if (num) countUp(num);
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));

  // Count numbers up from zero ("12+" -> 0..12 then "+")
  function countUp(el) {
    const m = el.textContent.match(/^(\d+)(.*)$/);
    if (!m) return;
    const target = +m[1], suffix = m[2], start = performance.now(), dur = 1200;
    const tick = now => {
      const t = Math.max(0, Math.min((now - start) / dur, 1));
      el.textContent = Math.round(target * (1 - Math.pow(1 - t, 3))) + suffix;
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // Hero test run: each suite "runs", then passes in turn; replays every few seconds
  const rows = [...document.querySelectorAll('.runs li')];
  const bar = document.querySelector('.bar i');
  const summary = document.querySelector('.dash .pass');
  const finals = rows.map(r => r.querySelector('.r-res').textContent);

  function playRun() {
    rows.forEach(r => { r.classList.add('running'); r.querySelector('.r-res').textContent = 'running'; });
    bar.style.transition = 'none';
    bar.style.width = '0%';
    summary.classList.remove('show');
    rows.forEach((r, i) => {
      setTimeout(() => {
        const res = r.querySelector('.r-res');
        r.classList.remove('running');
        const m = finals[i].match(/^(\d+)(.*)$/);
        if (m) {
          const target = +m[1], start = performance.now();
          const tick = now => {
            const t = Math.max(0, Math.min((now - start) / 500, 1));
            res.textContent = Math.round(target * t) + m[2];
            if (t < 1) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        } else {
          res.textContent = finals[i];
        }
        bar.style.transition = 'width .7s ease';
        bar.style.width = `${((i + 1) / rows.length) * 100}%`;
        if (i === rows.length - 1) setTimeout(() => summary.classList.add('show'), 500);
      }, 900 + i * 850);
    });
  }
  if (rows.length) {
    playRun();
    setInterval(() => { if (!document.hidden) playRun(); }, 11000);
  }
})();
