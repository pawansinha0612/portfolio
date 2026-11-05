/* Site-wide video slots, loaded by menu.js on every page:
   1. Footer: adds YouTube / TikTok / Instagram links next to LinkedIn once their URLs are in /videos/social.json.
   2. "Watch the video" card on any page a video in /videos/videos.json names as its `related` path.
   3. /learn/: a Videos card once there is at least one video.
   Nothing shows while the JSON files are empty. */
(() => {
  const get = (u) => fetch(u, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const lib = new Promise((res) => {
    if (window.Videos && window.Videos.card) return res(window.Videos);
    const s = document.createElement('script');
    s.src = '/videos/videos-lib.js';
    s.onload = () => res(window.Videos || null);
    s.onerror = () => res(null);
    document.head.appendChild(s);
  });

  Promise.all([lib, get('/videos/social.json'), get('/videos/videos.json')]).then(([V, social, data]) => {
    if (!V) return;

    // 1. Footer links
    const links = V.socialLinks(social || {}).filter((l) => l.key !== 'linkedin');
    if (links.length) {
      document.querySelectorAll('.footer-about p').forEach((p) => {
        if (!p.querySelector('a[href*="linkedin.com"]') || p.dataset.social) return;
        p.dataset.social = '1';
        links.forEach((l) => {
          p.appendChild(document.createTextNode(' · '));
          const a = document.createElement('a');
          a.href = l.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = l.label;
          a.dataset.track = 'footer-' + l.key;
          p.appendChild(a);
        });
      });
    }

    const videos = V.clean(data);
    if (!videos.length) return;
    const here = location.pathname;

    // 3. Learn hub card
    if (V.samePath(here, '/learn/')) {
      const grid = [...document.querySelectorAll('.grid')].find((g) => g.querySelector('a[href="/blog/"]'));
      if (grid && !grid.querySelector('a[href="/videos/"]')) {
        const a = document.createElement('a');
        a.className = 'card project-card'; a.href = '/videos/'; a.dataset.track = 'learn-videos';
        a.innerHTML = '<div class="icon">🎬</div><h3>Videos</h3><p>Screen-recorded walkthroughs and quick tips: load testing, AI for testers and interview prep. '
          + videos.length + (videos.length === 1 ? ' video' : ' videos') + ' so far.</p><span class="project-link">Watch →</span>';
        grid.appendChild(a);
      }
    }

    // 2. Related video card
    if (V.samePath(here, '/videos/')) return;
    const mine = videos.filter((v) => v.related && V.samePath(v.related, here)).slice(0, 2);
    if (!mine.length) return;
    V.injectCss();
    const sec = document.createElement('section');
    sec.className = 'wrap video-related';
    sec.innerHTML = '<div class="vr-box"><h2>🎬 Watch the video</h2><div class="vr-grid"></div><p class="vmeta" style="margin-top:12px"><a href="/videos/">All videos →</a></p></div>';
    const grid = sec.querySelector('.vr-grid');
    mine.forEach((v) => grid.appendChild(V.card(v)));
    const main = document.querySelector('main');
    const footer = document.querySelector('.site-footer, footer');
    const before = main && main.querySelector(':scope > .cta-end, :scope > .tools-end, :scope > .report-end');
    if (before) main.insertBefore(sec, before);
    else if (main) main.appendChild(sec);
    else if (footer) footer.before(sec);
    else document.body.appendChild(sec);
    // Line up with the page's own content column (some pages use a narrower centred .wrap than the default).
    const h1 = document.querySelector('main h1');
    const ref = h1 && h1.closest('main > *');
    if (ref && ref !== sec) {
      const cs = getComputedStyle(ref);
      if (cs.maxWidth !== 'none') sec.style.maxWidth = cs.maxWidth;
      const shift = h1.getBoundingClientRect().left - sec.querySelector('.vr-box').getBoundingClientRect().left;
      if (shift > 1 && shift < 400) sec.querySelector('.vr-box').style.marginLeft = shift + 'px';
    }
  });
})();
