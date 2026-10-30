/* Weekly digest signup (blog and tools pages).
   <form class="subscribe" data-endpoint="APPS_SCRIPT_URL" hidden> stays hidden until the Apps Script backend
   answers GET ?view=subscribe with { subscribe: true }, so the form never shows before the backend can take it.
   Posts form=subscribe to the same web app as the enquiry form (enquiry/Code.gs). */
(() => {
  const CSS = `
.subscribe { margin: 40px 0 0; padding: 26px 28px; border-radius: 16px; display: flex; flex-wrap: wrap; align-items: center; gap: 16px 28px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
  background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 9%, var(--surface)), color-mix(in srgb, var(--accent-2) 9%, var(--surface))); }
.subscribe[hidden] { display: none; }
.subscribe .sub-text { flex: 1 1 320px; }
.subscribe h2 { margin: 0 0 6px; font-size: 20px; line-height: 1.3; }
.subscribe p { margin: 0; color: var(--muted); font-size: 15px; }
.subscribe .sub-row { flex: 1 1 340px; display: flex; flex-wrap: wrap; gap: 10px; }
.subscribe input[type=email] { flex: 1 1 200px; min-width: 0; font: inherit; font-size: 16px; color: var(--text); background: var(--surface);
  border: 1px solid var(--border); border-radius: 10px; padding: 11px 13px; }
.subscribe input[type=email]:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.subscribe button { font: inherit; font-weight: 600; cursor: pointer; }
.subscribe button:disabled { opacity: .6; cursor: progress; }
.subscribe .hp { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
.subscribe .sub-status { flex-basis: 100%; font-size: 14px; color: var(--muted); min-height: 1em; }
.subscribe .sub-status:empty { display: none; }
@media (max-width: 600px) { .subscribe { padding: 22px 20px; } }`;

  const forms = document.querySelectorAll('form.subscribe[data-endpoint]');
  if (!forms.length) return;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const endpoint = forms[0].dataset.endpoint;
  fetch(endpoint + '?view=subscribe')
    .then(res => res.json())
    .then(out => { if (out && out.subscribe) forms.forEach(init); })
    .catch(() => {});

  function init(form) {
    form.hidden = false;
    const status = form.querySelector('.sub-status');
    const button = form.querySelector('button');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const email = form.elements.email;
      if (!email.checkValidity() || !email.value.trim()) {
        status.textContent = 'Please enter a valid email address.';
        email.focus();
        return;
      }
      button.disabled = true;
      status.textContent = 'Signing you up…';
      const body = new URLSearchParams(new FormData(form));
      body.append('form', 'subscribe');
      body.append('page', location.href);
      try {
        const out = await (await fetch(endpoint, { method: 'POST', body })).json();
        if (!out.ok) {
          status.textContent = out.error || 'Something went wrong. Please try again.';
          return;
        }
        form.reset();
        status.textContent = "You're in. A welcome email is on its way, and the first digest arrives on Sunday.";
        if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: 'subscribed', title: 'subscribed', event: true });
      } catch {
        status.textContent = "Sorry, that didn't go through. Please try again later.";
      } finally {
        button.disabled = false;
      }
    });
  }
})();
