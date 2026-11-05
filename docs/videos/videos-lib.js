/* Shared helpers for the videos page and the site-wide video slots (footer links, "Watch the video" card).
   Works in the browser (window.Videos) and in Node (module.exports) so videos.json can be checked by a test.
   Data: /videos/videos.json { videos: [...] } and /videos/social.json { youtube, tiktok, instagram, linkedin }. */
(function (root) {
  'use strict';

  const PLATFORMS = ['youtube', 'short', 'tiktok', 'instagram'];
  const TOPICS = { perf: 'Performance testing', 'ai-testing': 'AI for testing', 'ai-tips': 'AI tips', career: 'Career & interviews' };
  const PLATFORM_LABEL = { youtube: 'YouTube', short: 'YouTube Short', tiktok: 'TikTok', instagram: 'Instagram' };
  const SOCIAL = [
    ['youtube', 'YouTube', /^https:\/\/(www\.)?youtube\.com\//],
    ['tiktok', 'TikTok', /^https:\/\/(www\.)?tiktok\.com\//],
    ['instagram', 'Instagram', /^https:\/\/(www\.)?instagram\.com\//],
    ['linkedin', 'LinkedIn', /^https:\/\/(www\.)?linkedin\.com\//],
  ];

  // YouTube video id from watch?v=, youtu.be/, /shorts/, /embed/ or /live/ links. '' when it isn't one.
  function youtubeId(url) {
    let u;
    try { u = new URL(url); } catch (e) { return ''; }
    const host = u.hostname.replace(/^(www|m)\./, '');
    let id = '';
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
      else {
        const m = u.pathname.match(/^\/(shorts|embed|live)\/([^/?#]+)/);
        if (m) id = m[2];
      }
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : '';
  }

  // Returns a list of problems with one entry ([] = fine). Used to skip bad entries and in the test.
  function problems(v) {
    const out = [];
    if (!v || typeof v !== 'object') return ['not an object'];
    if (!PLATFORMS.includes(v.platform)) out.push('platform must be one of ' + PLATFORMS.join(', '));
    if (typeof v.url !== 'string' || !/^https:\/\//.test(v.url)) out.push('url must start with https://');
    else if ((v.platform === 'youtube' || v.platform === 'short') && !youtubeId(v.url)) out.push('url is not a YouTube video link');
    else if (v.platform === 'tiktok' && !/^https:\/\/(www\.|vm\.)?tiktok\.com\//.test(v.url)) out.push('url is not a TikTok link');
    else if (v.platform === 'instagram' && !/^https:\/\/(www\.)?instagram\.com\//.test(v.url)) out.push('url is not an Instagram link');
    if (typeof v.title !== 'string' || !v.title.trim()) out.push('title is missing');
    if (typeof v.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.date)) out.push('date must look like 2026-11-20');
    if (v.topic !== undefined && !(v.topic in TOPICS)) out.push('topic must be one of ' + Object.keys(TOPICS).join(', '));
    if (v.related !== undefined && v.related !== '' && (typeof v.related !== 'string' || !/^\/[^\s]*$/.test(v.related))) out.push('related must be a site path like /tools/jmeter-to-k6/');
    if (v.featured !== undefined && typeof v.featured !== 'boolean') out.push('featured must be true or false (no quotes)');
    return out;
  }

  function clean(data) {
    const list = data && Array.isArray(data.videos) ? data.videos : [];
    const ok = [];
    list.forEach((v, i) => {
      const p = problems(v);
      if (p.length) { if (typeof console !== 'undefined') console.warn('videos.json entry ' + (i + 1) + ' skipped: ' + p.join('; ')); }
      else ok.push(v);
    });
    return ok.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  // Compare page paths ignoring a trailing slash or index.html.
  function samePath(a, b) {
    const n = (p) => String(p || '').replace(/index\.html$/, '').replace(/\/+$/, '') || '/';
    return n(a) === n(b);
  }

  function socialLinks(social) {
    return SOCIAL.filter(([k, , re]) => social && typeof social[k] === 'string' && re.test(social[k]))
      .map(([k, label]) => ({ key: k, label, url: social[k] }));
  }

  const api = { PLATFORMS, TOPICS, PLATFORM_LABEL, youtubeId, problems, clean, samePath, socialLinks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Videos = api;
})(typeof window !== 'undefined' ? window : this);

/* Browser-only rendering shared by /videos/ and the "Watch the video" card. */
(function (root) {
  'use strict';
  if (typeof document === 'undefined' || !root.Videos) return;
  const V = root.Videos;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });

  // One video card. YouTube shows its thumbnail and only loads the (no-cookie) player after a click.
  V.card = function (v) {
    const el = document.createElement('article');
    const vertical = v.platform !== 'youtube';
    el.className = 'vcard' + (vertical ? ' vcard-vert' : '');
    el.dataset.topic = v.topic || '';
    const id = V.youtubeId(v.url);
    const meta = '<p class="vmeta"><span class="vbadge vb-' + v.platform + '">' + esc(V.PLATFORM_LABEL[v.platform]) + '</span>'
      + (v.topic ? ' · ' + esc(V.TOPICS[v.topic]) : '') + ' · ' + esc(fmtDate(v.date)) + '</p>';
    if (id) {
      const thumb = 'https://i.ytimg.com/vi/' + id + (vertical ? '/oar2.jpg' : '/hqdefault.jpg');
      el.innerHTML = '<div class="vframe"><button type="button" class="vplay" aria-label="Play video: ' + esc(v.title) + '">'
        + '<img src="' + thumb + '" alt="" loading="lazy" decoding="async" width="480" height="360">'
        + '<span class="vplay-icon" aria-hidden="true"></span></button></div>'
        + '<h3><a href="' + esc(v.url) + '" target="_blank" rel="noopener">' + esc(v.title) + '</a></h3>' + meta;
      const img = el.querySelector('img');
      img.addEventListener('error', () => { if (!img.dataset.retry) { img.dataset.retry = 1; img.src = 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg'; } }, { once: false });
      el.querySelector('.vplay').addEventListener('click', () => {
        const f = document.createElement('iframe');
        f.src = 'https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1&rel=0';
        f.title = v.title;
        f.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
        f.allowFullscreen = true;
        f.referrerPolicy = 'strict-origin-when-cross-origin';
        const frame = el.querySelector('.vframe');
        frame.innerHTML = '';
        frame.appendChild(f);
        if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: 'video-play ' + id, title: v.title, event: true });
      });
    } else {
      el.innerHTML = '<a class="vframe vlink vl-' + v.platform + '" href="' + esc(v.url) + '" target="_blank" rel="noopener" data-track="video-' + v.platform + '">'
        + '<span class="vlink-name">' + esc(V.PLATFORM_LABEL[v.platform]) + '</span><span class="vlink-go">Watch on ' + esc(V.PLATFORM_LABEL[v.platform]) + ' ↗</span></a>'
        + '<h3><a href="' + esc(v.url) + '" target="_blank" rel="noopener">' + esc(v.title) + '</a></h3>' + meta;
    }
    return el;
  };

  V.css = `
.vcard { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.vcard h3 { margin: 4px 0 0; font-size: 17px; line-height: 1.35; }
.vcard h3 a { color: var(--text); text-decoration: none; }
.vcard h3 a:hover { color: var(--accent); }
.vmeta { margin: 0; font-size: 13px; color: var(--muted); }
.vbadge { font-weight: 700; }
.vb-youtube, .vb-short { color: #d62b2b; } .vb-tiktok { color: var(--text); } .vb-instagram { color: #c13584; }
.vframe { position: relative; aspect-ratio: 16 / 9; border-radius: 14px; overflow: hidden; background: #0d1117; border: 1px solid var(--border); }
.vcard-vert .vframe { aspect-ratio: 9 / 16; max-height: 520px; }
.vframe iframe, .vplay, .vplay img { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
.vplay { padding: 0; cursor: pointer; background: #000; }
.vplay img { object-fit: cover; }
.vplay-icon { position: absolute; left: 50%; top: 50%; width: 68px; height: 48px; margin: -24px 0 0 -34px; border-radius: 12px; background: rgba(214, 43, 43, .92); }
.vplay-icon::after { content: ""; position: absolute; left: 28px; top: 14px; border-style: solid; border-width: 10px 0 10px 16px; border-color: transparent transparent transparent #fff; }
.vplay:hover .vplay-icon, .vplay:focus-visible .vplay-icon { background: #d62b2b; }
.vlink { display: flex; flex-direction: column; justify-content: flex-end; gap: 4px; padding: 18px; color: #fff; text-decoration: none; }
.vl-tiktok { background: linear-gradient(160deg, #161823 55%, #2b1a2e 80%, #3b1626); box-shadow: inset 3px 0 #25f4ee, inset -3px 0 #fe2c55; }
.vl-instagram { background: linear-gradient(150deg, #833ab4, #fd1d1d 60%, #fcb045); }
.vlink-name { font-size: 22px; font-weight: 800; }
.vlink-go { font-size: 14px; opacity: .9; }
.video-related { padding-top: 8px; padding-bottom: 40px; }
.video-related .vr-box { border: 1px solid var(--border); border-radius: 16px; background: var(--surface); padding: 18px; max-width: 900px; }
.video-related h2 { margin: 0 0 12px; font-size: 20px; }
.video-related .vr-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); }
.video-related .vcard-vert { max-width: 300px; }
`;
  V.injectCss = function () {
    if (document.getElementById('videos-css')) return;
    const s = document.createElement('style');
    s.id = 'videos-css';
    s.textContent = V.css;
    document.head.appendChild(s);
  };
})(typeof window !== 'undefined' ? window : this);
