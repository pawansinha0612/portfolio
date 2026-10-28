/*
 * Chat assistant: a scripted (not AI) helper that asks visitors why they're here and what they're
 * looking for, then saves the answers to the "Chat" tab of the enquiries Google Sheet.
 *
 * Include on a page with:
 *   <link rel="stylesheet" href="/chat.css">
 *   <script src="/chat.js" data-endpoint="<Apps Script /exec URL>" data-booking-url="<Calendly URL>" defer></script>
 * On the interview prep page it also calls window.prepPage.show(level, topic) to filter the questions.
 */
(() => {
  const script = document.currentScript;
  const ENDPOINT = script.dataset.endpoint || '';
  const BOOKING = script.dataset.bookingUrl || '';
  const SEEN = 'chat-seen';
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };

  // Answers collected so far; posted once, when the conversation ends or the visitor leaves.
  const answers = { reason: '', level: '', topics: '', missing: '', name: '', email: '', message: '' };
  let sent = false;

  // ----- UI -----
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  const launch = el('button', 'chat-launch', '💬 Quick question?');
  launch.type = 'button';
  const teaser = el('div', 'chat-teaser', "Hi! Preparing for an interview or hiring? Tell me what you're looking for and I'll point you to the right questions.");
  teaser.hidden = true;

  const panel = el('section', 'chat-panel');
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Chat assistant');
  panel.innerHTML = `
    <div class="chat-head"><div><b>Pawan's assistant</b><span>Automated · replies instantly</span></div>
      <button class="chat-close" type="button" aria-label="Close chat">×</button></div>
    <div class="chat-log" role="log" aria-live="polite"></div>
    <form class="chat-form"><input type="text" disabled placeholder="Choose an option above" aria-label="Your reply" maxlength="500">
      <button class="btn btn-small" type="submit" disabled>Send</button></form>
    <p class="chat-note">Your answers go to Pawan only and are never shared.</p>`;
  document.body.append(launch, teaser, panel);

  const log = panel.querySelector('.chat-log');
  const form = panel.querySelector('.chat-form');
  const input = form.querySelector('input');
  const sendBtn = form.querySelector('button');
  let onText = null;
  let skipRow = null;
  const esc = t => t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function say(text, who = 'bot') {
    const m = el('div', 'chat-msg ' + who);
    if (who === 'bot') m.innerHTML = text; else m.textContent = text;
    log.appendChild(m);
    log.scrollTop = log.scrollHeight;
  }

  function options(list) {
    const row = el('div', 'chat-opts');
    list.forEach(([label, fn]) => {
      const b = el('button', 'chat-opt', label);
      b.type = 'button';
      b.addEventListener('click', () => { row.remove(); say(label, 'me'); fn(); });
      row.appendChild(b);
    });
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    return row;
  }

  // Ask for free text. skip = label of an optional "skip" button.
  function ask(placeholder, fn, skip, type = 'text') {
    input.type = type;
    input.placeholder = placeholder;
    input.disabled = sendBtn.disabled = false;
    input.focus();
    onText = fn;
    if (skip) skipRow = options([[skip, () => { stopAsking(); fn(''); }]]);
  }
  function stopAsking() {
    onText = null;
    input.value = '';
    input.type = 'text';
    input.placeholder = 'Choose an option above';
    input.disabled = sendBtn.disabled = true;
    if (skipRow) { skipRow.remove(); skipRow = null; }
  }
  form.addEventListener('submit', e => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v || !onText) return;
    const fn = onText;
    say(v, 'me');
    stopAsking();
    fn(v);
  });

  // ----- Conversation -----
  const LEVELS = [['Under 3 years', 'basic'], ['3–5 years', 'basic'], ['5–7 years', 'intermediate'], ['7+ years', 'advanced']];
  const TOPICS = ['k6', 'LoadRunner', 'JMeter', 'Gatling', 'Observability', 'Cloud', 'Database'];
  const prep = () => window.prepPage;

  function start() {
    say("Hi 👋 I'm an automated helper on Pawan's site. What brings you here today?");
    options([
      ['Preparing for an interview', interview],
      ['Hiring a performance or QA engineer', hiring],
      ['Learning performance testing', learning],
      ['Just browsing', browsing],
    ]);
  }

  function interview() {
    answers.reason = 'Interview prep';
    say('Good luck! How many years of experience do you have?');
    options(LEVELS.map(([label, lvl]) => [label, () => { answers.level = label; pickTopic(lvl); }]));
  }

  function pickTopic(lvl) {
    say('Which tool or topic do you want to focus on?');
    options([...TOPICS, 'Everything'].map(t => [t, () => {
      answers.topics = t;
      const topic = t === 'Everything' ? '' : t;
      if (prep()) {
        const n = prep().show(lvl, topic);
        say(`I've opened the ${lvl} level${topic ? ' filtered to ' + topic : ''}: ${n} question${n === 1 ? '' : 's'}. Tick "Practised" as you go.`);
      } else {
        say(`Have a look at the <a href="/interview-prep/performance-testing/#${lvl}">${lvl} questions</a>.`);
      }
      missingTopic();
    }]));
  }

  function missingTopic() {
    say("Is there a question or topic you're expecting in your interview that isn't here? Pawan adds the most requested ones.");
    ask('e.g. Kafka consumer lag, NeoLoad, Azure Load Testing', v => { answers.missing = v; subscribe(); }, 'Nothing for now');
  }

  function subscribe() {
    say('Want an email when new questions or blog posts go up? Leave your email, or skip.');
    ask('you@example.com', v => {
      if (v && !EMAIL_RE.test(v)) { say("That email doesn't look right. Try again, or skip."); return subscribe(); }
      answers.email = v;
      finish(v ? "Thanks, you're on the list. All the best with the interview!" : 'No problem. All the best with the interview!');
    }, 'Skip', 'email');
  }

  function hiring() {
    answers.reason = 'Hiring';
    say('Great. What do you need help with?');
    options([
      'Load testing before a launch',
      'Fixing a slow or unstable system',
      'Setting up a performance framework or CI',
      'Test automation or QA',
      'Something else',
    ].map(t => [t, () => { answers.topics = t; hiringName(); }]));
  }
  function hiringName() {
    say("What's your name?");
    ask('Your name', v => { answers.name = v; hiringEmail(); });
  }
  function hiringEmail() {
    say(`Thanks ${esc(answers.name.split(/\s+/)[0])}. What's the best email to reach you?`);
    ask('you@company.com', v => {
      if (!EMAIL_RE.test(v)) { say("That email doesn't look right. Please try again."); return hiringEmail(); }
      answers.email = v;
      say('Anything else Pawan should know? For example your product, timeline or tools.');
      ask('A sentence or two', m => {
        answers.message = m;
        finish('Thanks! Pawan will reply within one business day.' +
          (BOOKING ? ` If you'd rather talk now, <a href="${BOOKING}" target="_blank" rel="noopener">book a free 30-minute call</a>.` : ''));
      }, 'Nothing else');
    }, null, 'email');
  }

  function learning() {
    answers.reason = 'Learning';
    if (prep()) prep().show('basic', '');
    say('Nice. The <b>Basic</b> tab is the best place to start: types of tests, metrics, workload models and scripting. Which tool are you learning?');
    options([...TOPICS, 'Not sure yet'].map(t => [t, () => {
      answers.topics = t;
      if (prep() && t !== 'Not sure yet') prep().show('basic', t);
      missingTopic();
    }]));
  }

  function browsing() {
    answers.reason = 'Browsing';
    say('Welcome! Were you looking for anything in particular?');
    ask('Type it here', v => { answers.missing = v; finish('Thanks, that helps Pawan decide what to write next.'); }, 'No, just looking');
  }

  function finish(text) {
    say(text);
    send();
    store.set(SEEN, 'done');
  }

  // ----- Saving -----
  function payload() {
    const body = new URLSearchParams({ form: 'chat', page: location.href });
    Object.entries(answers).forEach(([k, v]) => body.append(k, v));
    return body;
  }
  function send() {
    if (sent || !answers.reason || !ENDPOINT) return;
    sent = true;
    fetch(ENDPOINT, { method: 'POST', body: payload() }).catch(() => {});
  }
  // Keep partial answers if the visitor leaves part-way through.
  addEventListener('pagehide', () => {
    if (sent || !answers.reason || !ENDPOINT) return;
    sent = true;
    navigator.sendBeacon(ENDPOINT, payload());
  });

  // ----- Open / close -----
  let started = false;
  function open() {
    panel.hidden = false;
    launch.hidden = teaser.hidden = true;
    store.set(SEEN, store.get(SEEN) || 'opened');
    if (!started) { started = true; start(); }
  }
  function close() {
    panel.hidden = true;
    launch.hidden = false;
  }
  launch.addEventListener('click', open);
  teaser.addEventListener('click', open);
  panel.querySelector('.chat-close').addEventListener('click', close);
  addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) close(); });

  // Nudge first-time visitors once, after they've had a chance to look around.
  if (!store.get(SEEN)) {
    setTimeout(() => { if (panel.hidden && !started) teaser.hidden = false; }, 12000);
  }
})();
