/* Shared helpers for /play/ games: best score (localStorage, never required) and share buttons. */
(function () {
  'use strict';
  const store = {
    get(key) { try { const v = localStorage.getItem('play:' + key); return v == null ? null : JSON.parse(v); } catch (e) { return null; } },
    set(key, val) { try { localStorage.setItem('play:' + key, JSON.stringify(val)); } catch (e) { /* private mode: fine */ } },
  };

  function track(name) {
    try { if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: name, title: name, event: true }); } catch (e) {}
  }

  // Renders Share / Copy / LinkedIn buttons into el. text is the message; url the page to share.
  function shareButtons(el, text, url, prefix) {
    el.innerHTML = '';
    const mk = (label, track) => { const b = document.createElement(track === 'li' ? 'a' : 'button'); b.className = 'gbtn'; b.textContent = label;
      if (track !== 'li') b.type = 'button'; b.dataset.track = prefix + '-share-' + track; el.appendChild(b); return b; };
    if (navigator.share) {
      mk('Share…', 'native').addEventListener('click', () => { navigator.share({ title: document.title, text, url }).catch(() => {}); });
    }
    const copy = mk('Copy result', 'copy');
    copy.addEventListener('click', async () => {
      const full = text + ' ' + url;
      try { await navigator.clipboard.writeText(full); copy.textContent = 'Copied ✓'; }
      catch (e) { window.prompt('Copy this:', full); }
      setTimeout(() => { copy.textContent = 'Copy result'; }, 1800);
    });
    const li = mk('Post on LinkedIn', 'li');
    li.href = 'https://www.linkedin.com/sharing/share-offsite/?url=' + encodeURIComponent(url);
    li.target = '_blank'; li.rel = 'noopener';
    li.title = 'LinkedIn shares the link; paste your copied result as the text';
  }

  // Unhide links only once their target returns 200 (same idea as the tools page's deep-dive links).
  function checkLinks(root) {
    root.querySelectorAll('a[data-check]').forEach(a => {
      fetch(a.getAttribute('href'), { method: 'HEAD' }).then(r => { if (r.ok) a.hidden = false; }).catch(() => {});
    });
  }

  window.Play = { store, track, shareButtons, checkLinks };
})();
