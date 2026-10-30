// Sends the contact form to Formspree without leaving the page. Without JavaScript the form still works.
(() => {
  const form = document.getElementById('enquiry');
  if (!form) return;
  const status = form.querySelector('.enquiry-status');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    status.textContent = 'Sending…';
    try {
      const res = await fetch(form.action, { method: 'POST', body: new FormData(form), headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error();
      form.reset();
      status.textContent = 'Thanks! Your message is on its way. I will reply within one business day.';
    } catch {
      status.textContent = 'Sorry, that did not send. Please email me instead.';
    } finally {
      button.disabled = false;
    }
  });
})();
