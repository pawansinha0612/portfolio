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
  // Split headings into words so they can rise in one after another
  function splitWords(el) {
    let i = 0;
    const walk = node => {
      [...node.childNodes].forEach(child => {
        if (child.nodeType === Node.TEXT_NODE) {
          const frag = document.createDocumentFragment();
          const isHl = node.classList && node.classList.contains('hl');
          child.textContent.split(/(\s+)/).forEach(part => {
            if (!part) return;
            if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); return; }
            const w = document.createElement('span');
            w.className = 'word' + (isHl ? ' hl' : '');
            w.style.setProperty('--i', i++);
            w.textContent = part;
            frag.appendChild(w);
          });
          child.replaceWith(frag);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          walk(child);
        }
      });
      if (node.classList && node.classList.contains('hl')) node.classList.remove('hl');
    };
    walk(el);
    el.classList.add('split-ready');
  }
  document.querySelectorAll('.split, .section h2, .contact h2').forEach(splitWords);

  const groups = [
    '.section h2, .contact h2, .section .eyebrow, .section-lead',
    '.stats > div', '.grid > .card', '.cases > .case', '.steps > li',
    '.toolkit > div', '.ticks > li', '.contact-inner > :not(h2)', '.trust .wrap > *',
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

  // Hero headline plays on load rather than on scroll
  document.querySelectorAll('.split').forEach(h => requestAnimationFrame(() => h.classList.add('in')));

  // Infinite marquees: repeat the items so one copy is wider than the screen, then double it
  document.querySelectorAll('.marquee-track').forEach(track => {
    const items = track.innerHTML;
    track.innerHTML = items.repeat(3);
    track.innerHTML += track.innerHTML;
    track.classList.add('running');
  });

  // Scroll-driven effects: progress bar, parallax, statement fill, pinned steps
  const progress = document.querySelector('.progress');
  const parallax = [...document.querySelectorAll('[data-parallax]')];
  const statement = document.querySelector('.statement');
  if (statement) splitWords(statement);
  const statementWords = statement ? [...statement.querySelectorAll('.word')] : [];
  const steps = [...document.querySelectorAll('.steps-pinned > li')];
  let ticking = false;
  function onScrollFx() {
    ticking = false;
    const y = window.scrollY, vh = window.innerHeight;
    const max = document.documentElement.scrollHeight - vh;
    progress.style.transform = `scaleX(${max > 0 ? y / max : 0})`;
    parallax.forEach(el => { el.style.translate = `0 ${y * +el.dataset.parallax}px`; });
    if (statement) {
      const r = statement.getBoundingClientRect();
      const p = Math.min(Math.max((vh * 0.8 - r.top) / (r.height + vh * 0.3), 0), 1);
      const lit = Math.round(p * statementWords.length);
      statementWords.forEach((w, i) => w.classList.toggle('lit', i < lit));
    }
    if (steps.length) {
      let best = null, bestDist = Infinity;
      steps.forEach(li => {
        const r = li.getBoundingClientRect();
        const d = Math.abs(r.top + r.height / 2 - vh * 0.5);
        if (d < bestDist) { bestDist = d; best = li; }
      });
      steps.forEach(li => li.classList.toggle('active', li === best));
    }
  }
  window.addEventListener('scroll', () => {
    if (!ticking) { ticking = true; requestAnimationFrame(onScrollFx); }
  }, { passive: true });
  window.addEventListener('resize', onScrollFx);
  onScrollFx();

  // Pointer effects (mouse/trackpad only): cursor glow, card spotlight, magnetic buttons
  if (window.matchMedia('(pointer: fine)').matches) {
    const glow = document.querySelector('.cursor-glow');
    let gx = innerWidth / 2, gy = innerHeight / 2, tx = gx, ty = gy;
    window.addEventListener('mousemove', e => { tx = e.clientX; ty = e.clientY; glow.classList.add('on'); }, { passive: true });
    document.addEventListener('mouseleave', () => glow.classList.remove('on'));
    (function follow() {
      gx += (tx - gx) * 0.12; gy += (ty - gy) * 0.12;
      glow.style.transform = `translate(${gx}px, ${gy}px)`;
      requestAnimationFrame(follow);
    })();

    document.querySelectorAll('.card, .case').forEach(card => {
      card.addEventListener('mousemove', e => {
        const r = card.getBoundingClientRect();
        card.style.setProperty('--mx', `${e.clientX - r.left}px`);
        card.style.setProperty('--my', `${e.clientY - r.top}px`);
      });
    });

    document.querySelectorAll('.btn').forEach(btn => {
      btn.addEventListener('mousemove', e => {
        const r = btn.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
        btn.style.transform = `translate(${dx * 0.25}px, ${dy * 0.35}px)`;
      });
      btn.addEventListener('mouseleave', () => { btn.style.transform = ''; });
    });
  }

  // Smooth, eased scrolling (Lenis); anchor links glide to their section under the sticky nav
  window.addEventListener('load', () => {
    if (!window.Lenis) return;
    const lenis = new Lenis({ duration: 1.15, smoothWheel: true });
    (function raf(t) { lenis.raf(t); requestAnimationFrame(raf); })(performance.now());
    document.documentElement.style.scrollBehavior = 'auto';
    document.querySelectorAll('a[href^="#"]').forEach(a => {
      a.addEventListener('click', e => {
        const target = document.querySelector(a.getAttribute('href'));
        if (!target) return;
        e.preventDefault();
        lenis.scrollTo(target, { offset: -70 });
      });
    });
  });

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
