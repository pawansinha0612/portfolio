/**
 * Backend for the forms on pawansinha.com.au.
 *
 * Runs as a Google Apps Script web app attached to a Google Sheet.
 *
 * Enquiry form (home page): each submission is
 *   1. added as a row to the "Enquiries" tab,
 *   2. emailed to OWNER_EMAIL (hit Reply to answer the visitor directly),
 *   3. acknowledged with a short confirmation email to the visitor.
 *
 * Feedback form (/feedback/, a private link sent to people I've worked with): each submission is
 *   1. added to the "Testimonials" tab with "approved" left blank,
 *   2. emailed to OWNER_EMAIL, and a thank-you sent to the person.
 * Rows set to approved = Yes are returned by GET ?view=testimonials and shown on the home page.
 *
 * Chat assistant (docs/chat.js, on the interview prep page): each conversation is
 *   1. added to the "Chat" tab (created automatically on first use),
 *   2. emailed to OWNER_EMAIL when the visitor is hiring or left an email address.
 *
 * Weekly digest signup (docs/subscribe.js, on blog and tools pages): each signup is
 *   1. added to the "Subscribers" tab with an unsubscribe token, and sent a welcome email,
 *   2. emailed every Sunday by sendWeeklyDigest() with the past week's blog posts (from the RSS feed).
 * Every email has a one-click unsubscribe link (GET ?unsubscribe=TOKEN), as the Spam Act requires.
 * The signup form stays hidden on the site until GET ?view=subscribe answers, so it only appears once this
 * version is deployed.
 *
 * Run setup() once from the editor (it also creates the Sunday digest trigger), then deploy as a web app
 * (Execute as: Me, Who has access: Anyone) and paste the /exec URL into data-endpoint on the forms in docs/.
 * After changing this code: Deploy → Manage deployments → edit → Version: New version → Deploy.
 */

const OWNER_EMAIL = 'pawansinha4u@gmail.com';
const MY_NAME = 'Pawan Sinha';

const ENQUIRY_SHEET = 'Enquiries';
const ENQUIRY_FIELDS = ['name', 'email', 'company', 'need', 'website', 'timeline', 'message'];
const ENQUIRY_HEADERS = ['received', ...ENQUIRY_FIELDS, 'page', 'status'];

const TESTIMONIAL_SHEET = 'Testimonials';
const TESTIMONIAL_FIELDS = ['name', 'title', 'company', 'relationship', 'quote', 'email', 'linkedin'];
const TESTIMONIAL_HEADERS = ['received', ...TESTIMONIAL_FIELDS, 'consent', 'approved'];

const CHAT_SHEET = 'Chat';
const CHAT_FIELDS = ['reason', 'level', 'topics', 'missing', 'name', 'email', 'message'];
const CHAT_HEADERS = ['received', ...CHAT_FIELDS, 'page', 'status'];

const SUBSCRIBER_SHEET = 'Subscribers';
const SUBSCRIBER_HEADERS = ['subscribed', 'email', 'page', 'status', 'token', 'unsubscribed'];
const FEED_URL = 'https://pawansinha.com.au/blog/feed.xml';
const SITE_URL = 'https://pawansinha.com.au';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function setup() {
  const enquiries = sheetWithHeaders(ENQUIRY_SHEET, ENQUIRY_HEADERS);
  dropdown(enquiries, ENQUIRY_HEADERS.length, ['New', 'Replied', 'Call booked', 'Won', 'Lost', 'Spam']);
  const testimonials = sheetWithHeaders(TESTIMONIAL_SHEET, TESTIMONIAL_HEADERS);
  dropdown(testimonials, TESTIMONIAL_HEADERS.length, ['Yes', 'No']);
  chatSheet();
  subscriberSheet();
  installWeeklyDigest();
}

function subscriberSheet() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SUBSCRIBER_SHEET);
  if (sh) return sh;
  const created = sheetWithHeaders(SUBSCRIBER_SHEET, SUBSCRIBER_HEADERS);
  dropdown(created, SUBSCRIBER_HEADERS.indexOf('status') + 1, ['Active', 'Unsubscribed']);
  return created;
}

// Sends the digest every Sunday morning (Melbourne time). Safe to run again: it replaces the old trigger.
function installWeeklyDigest() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'sendWeeklyDigest')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sendWeeklyDigest').timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(9).inTimezone('Australia/Melbourne').create();
}

function chatSheet() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CHAT_SHEET);
  if (sh) return sh;
  const created = sheetWithHeaders(CHAT_SHEET, CHAT_HEADERS);
  dropdown(created, CHAT_HEADERS.length, ['New', 'Replied', 'Subscribed', 'Done']);
  return created;
}

function sheetWithHeaders(name, headers) {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}

function dropdown(sh, col, values) {
  sh.getRange(2, col, sh.getMaxRows() - 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(values).build());
}

// GET ?view=testimonials returns the approved quotes for the home page.
// Any other GET confirms the deployment is live.
function doGet(e) {
  const q = (e && e.parameter) || {};
  if (q.view === 'subscribe') return json({ ok: true, subscribe: true });
  if (q.unsubscribe) return unsubscribePage(q.unsubscribe);
  if (q.view === 'testimonials') {
    const sh = SpreadsheetApp.getActive().getSheetByName(TESTIMONIAL_SHEET);
    const rows = sh ? sh.getDataRange().getValues().slice(1) : [];
    const col = h => TESTIMONIAL_HEADERS.indexOf(h);
    const testimonials = rows
      .filter(r => String(r[col('approved')]).trim().toLowerCase() === 'yes' && r[col('quote')])
      .map(r => ({
        quote: String(r[col('quote')]),
        name: String(r[col('name')]),
        title: String(r[col('title')]),
        company: String(r[col('company')]),
      }));
    return json({ ok: true, testimonials });
  }
  return json({ ok: true, service: 'enquiry form' });
}

function doPost(e) {
  const p = (e && e.parameter) || {};

  // Honeypot: the field is hidden from people, so anything in it came from a bot.
  // Reply "ok" so the bot moves on.
  if (p.company_site) return json({ ok: true });

  if (p.form === 'chat') return saveChat(p);
  if (p.form === 'subscribe') return saveSubscriber(p);
  return p.form === 'testimonial' ? saveTestimonial(p) : saveEnquiry(p);
}

function saveEnquiry(p) {
  const d = clean(p, ENQUIRY_FIELDS, { message: 3000 });
  if (!d.name || !d.message || !EMAIL_RE.test(d.email)) {
    return json({ ok: false, error: 'Please add your name, a valid email and a short message.' });
  }
  if (isRepeat('enquiry', d.email)) return json({ ok: true });

  appendRow(ENQUIRY_SHEET, [new Date(), ...ENQUIRY_FIELDS.map(f => safe(d[f])), safe(String(p.page || '').slice(0, 300)), 'New']);

  const lines = [
    'Name:      ' + d.name,
    'Email:     ' + d.email,
    'Company:   ' + (d.company || '-'),
    'Need:      ' + (d.need || '-'),
    'Website:   ' + (d.website || '-'),
    'Timeline:  ' + (d.timeline || '-'),
    '',
    d.message,
    '',
    '— Sent from the form on ' + (p.page || 'pawansinha.com.au'),
  ];
  MailApp.sendEmail({
    to: OWNER_EMAIL,
    replyTo: d.email,
    subject: 'New enquiry: ' + d.name + (d.company ? ' (' + d.company + ')' : '') + (d.need ? ' · ' + d.need : ''),
    body: lines.join('\n'),
  });

  MailApp.sendEmail({
    to: d.email,
    name: MY_NAME,
    replyTo: OWNER_EMAIL,
    subject: 'Thanks for getting in touch',
    body: 'Hi ' + firstName(d.name) + ',\n\n' +
      "Thanks for your message. I've received it and will reply within one business day.\n\n" +
      'If anything is urgent, just reply to this email.\n\n' + signature(),
  });

  return json({ ok: true });
}

function saveTestimonial(p) {
  const d = clean(p, TESTIMONIAL_FIELDS, { quote: 1000 });
  if (!d.name || !d.quote || !EMAIL_RE.test(d.email)) {
    return json({ ok: false, error: 'Please add your name, your email and your feedback.' });
  }
  if (p.consent !== 'yes') {
    return json({ ok: false, error: 'Please tick the box to confirm I can show your feedback on my website.' });
  }
  if (isRepeat('testimonial', d.email)) return json({ ok: true });

  appendRow(TESTIMONIAL_SHEET, [new Date(), ...TESTIMONIAL_FIELDS.map(f => safe(d[f])), 'Yes', '']);

  MailApp.sendEmail({
    to: OWNER_EMAIL,
    replyTo: d.email,
    subject: 'New testimonial: ' + d.name + (d.company ? ' (' + d.company + ')' : ''),
    body: [
      'Name:          ' + d.name,
      'Title:         ' + (d.title || '-'),
      'Company:       ' + (d.company || '-'),
      'Relationship:  ' + (d.relationship || '-'),
      'Email:         ' + d.email,
      'LinkedIn:      ' + (d.linkedin || '-'),
      '',
      d.quote,
      '',
      'To publish it, set "approved" to Yes on the Testimonials tab of your Website enquiries sheet.',
    ].join('\n'),
  });

  MailApp.sendEmail({
    to: d.email,
    name: MY_NAME,
    replyTo: OWNER_EMAIL,
    subject: 'Thank you for the testimonial',
    body: 'Hi ' + firstName(d.name) + ',\n\n' +
      "Thank you so much for taking the time to write this. I really appreciate it.\n\n" +
      "If you'd like to change anything before it goes on my website, just reply to this email.\n\n" + signature(),
  });

  return json({ ok: true });
}

function saveChat(p) {
  const d = clean(p, CHAT_FIELDS, { message: 2000, missing: 500 });
  if (!d.reason) return json({ ok: false });
  if (d.email && !EMAIL_RE.test(d.email)) d.email = '';
  if (d.email && isRepeat('chat', d.email)) return json({ ok: true });

  chatSheet();
  appendRow(CHAT_SHEET, [new Date(), ...CHAT_FIELDS.map(f => safe(d[f])), safe(String(p.page || '').slice(0, 300)), 'New']);

  // Only email when there's something to act on: a hiring lead or someone who left an address.
  if (d.reason === 'Hiring' || d.email) {
    MailApp.sendEmail({
      to: OWNER_EMAIL,
      replyTo: d.email || OWNER_EMAIL,
      subject: 'Chat: ' + d.reason + (d.name ? ' · ' + d.name : '') + (d.topics ? ' · ' + d.topics : ''),
      body: CHAT_FIELDS.map(f => (f + ':          ').slice(0, 10) + (d[f] || '-')).join('\n') +
        '\n\n— From the chat on ' + (p.page || 'pawansinha.com.au'),
    });
  }
  return json({ ok: true });
}

function saveSubscriber(p) {
  const email = String(p.email || '').trim().toLowerCase().slice(0, 200);
  if (!EMAIL_RE.test(email)) return json({ ok: false, error: 'Please enter a valid email address.' });
  if (isRepeat('subscribe', email)) return json({ ok: true });

  const sh = subscriberSheet();
  const rows = sh.getDataRange().getValues();
  const col = h => SUBSCRIBER_HEADERS.indexOf(h);
  const i = rows.findIndex((r, n) => n > 0 && String(r[col('email')]).toLowerCase() === email);
  let token;
  if (i > 0) {
    if (rows[i][col('status')] === 'Active') return json({ ok: true });  // already subscribed: no second welcome
    token = rows[i][col('token')] || Utilities.getUuid();
    sh.getRange(i + 1, 1, 1, SUBSCRIBER_HEADERS.length).setValues([[new Date(), email,
      safe(String(p.page || '').slice(0, 300)), 'Active', token, '']]);
  } else {
    token = Utilities.getUuid();
    appendRow(SUBSCRIBER_SHEET, [new Date(), email, safe(String(p.page || '').slice(0, 300)), 'Active', token, '']);
  }

  MailApp.sendEmail({
    to: email,
    name: MY_NAME,
    replyTo: OWNER_EMAIL,
    subject: "You're subscribed: one performance deep dive a week",
    body: 'Hi,\n\n' +
      "Thanks for subscribing. Every Sunday morning you'll get a short email with that week's posts on performance " +
      'engineering: bottlenecks, load testing, caching, databases, cloud and more, each with an interactive calculator.\n\n' +
      'Catch up on everything so far: ' + SITE_URL + '/blog/\n' +
      'Free performance calculators: ' + SITE_URL + '/tools/\n\n' +
      signature() + '\n\n' + unsubscribeFooter(token),
  });
  return json({ ok: true });
}

function unsubscribeFooter(token) {
  return "You're getting this because you subscribed at pawansinha.com.au.\n" +
    'Unsubscribe with one click: ' + ScriptApp.getService().getUrl() + '?unsubscribe=' + encodeURIComponent(token);
}

function unsubscribePage(token) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SUBSCRIBER_SHEET);
  const col = h => SUBSCRIBER_HEADERS.indexOf(h);
  let done = false;
  if (sh) {
    const rows = sh.getDataRange().getValues();
    const i = rows.findIndex((r, n) => n > 0 && String(r[col('token')]) === String(token));
    if (i > 0) {
      sh.getRange(i + 1, col('status') + 1).setValue('Unsubscribed');
      sh.getRange(i + 1, col('unsubscribed') + 1).setValue(new Date());
      done = true;
    }
  }
  const msg = done
    ? "You're unsubscribed and won't get any more digest emails. Sorry to see you go."
    : "That unsubscribe link didn't match a subscriber. You may already be unsubscribed. If emails keep arriving, reply to one and I'll remove you.";
  return HtmlService.createHtmlOutput(
    '<div style="font:17px/1.6 system-ui,sans-serif;max-width:560px;margin:60px auto;padding:0 16px">' +
    '<h2>Pawan Sinha · weekly digest</h2><p>' + msg + '</p><p><a href="' + SITE_URL + '/blog/">Back to the blog</a></p></div>')
    .setTitle('Unsubscribe');
}

// Runs every Sunday (see installWeeklyDigest). Emails active subscribers the posts published in the last 7 days.
// Skips the week quietly when there are no new posts. Run it by hand to test: it emails you a preview first if
// PREVIEW_ONLY is true.
const PREVIEW_ONLY = false;

function sendWeeklyDigest() {
  const posts = recentPosts(7);
  if (!posts.length) return;

  const intro = posts.length === 1 ? "This week's deep dive:" : "This week's deep dives:";
  const text = posts.map(p => '- ' + p.title + '\n  ' + p.summary + '\n  ' + p.link).join('\n\n');
  const subject = posts.length === 1 ? posts[0].title : posts[0].title + ' (+' + (posts.length - 1) + ' more)';

  if (PREVIEW_ONLY) {
    MailApp.sendEmail({ to: OWNER_EMAIL, name: MY_NAME, subject: '[Preview] ' + subject,
      body: 'Hi,\n\n' + intro + '\n\n' + text + '\n\n' + signature() });
    return;
  }

  const sh = SpreadsheetApp.getActive().getSheetByName(SUBSCRIBER_SHEET);
  if (!sh) return;
  const col = h => SUBSCRIBER_HEADERS.indexOf(h);
  const active = sh.getDataRange().getValues().slice(1).filter(r => r[col('status')] === 'Active' && EMAIL_RE.test(r[col('email')]));
  let sent = 0;
  for (const r of active) {
    if (MailApp.getRemainingDailyQuota() < 5) break;  // keep a few emails for enquiry notifications
    MailApp.sendEmail({
      to: String(r[col('email')]),
      name: MY_NAME,
      replyTo: OWNER_EMAIL,
      subject: subject,
      body: 'Hi,\n\n' + intro + '\n\n' + text + '\n\n' +
        'Free performance calculators: ' + SITE_URL + '/tools/\n\n' + signature() + '\n\n' + unsubscribeFooter(r[col('token')]),
    });
    sent++;
  }
  if (sent < active.length) {
    MailApp.sendEmail({ to: OWNER_EMAIL, subject: 'Weekly digest: daily email limit reached',
      body: 'Sent ' + sent + ' of ' + active.length + ' digests. Google limits how many emails a script can send per day. ' +
        'Run sendWeeklyDigest again tomorrow from the Apps Script editor to send the rest (people already emailed will get it twice), ' +
        'or move to a mailing service once the list grows.' });
  }
}

function recentPosts(days) {
  const xml = UrlFetchApp.fetch(FEED_URL, { muteHttpExceptions: true }).getContentText();
  const items = XmlService.parse(xml).getRootElement().getChild('channel').getChildren('item');
  const since = Date.now() - days * 24 * 3600 * 1000;
  return items
    .map(it => ({
      title: it.getChildText('title'),
      link: it.getChildText('link'),
      summary: it.getChildText('description'),
      date: new Date(it.getChildText('pubDate')),
    }))
    .filter(p => p.date.getTime() > since && p.date.getTime() <= Date.now())
    .sort((a, b) => a.date - b.date);
}

function clean(p, fields, longLimits) {
  const d = {};
  fields.forEach(f => { d[f] = String(p[f] || '').trim().slice(0, longLimits[f] || 200); });
  return d;
}

// Ignore double-clicks and repeat sends from the same address for a minute
function isRepeat(kind, email) {
  const cache = CacheService.getScriptCache();
  const key = kind + ':' + email.toLowerCase();
  if (cache.get(key)) return true;
  cache.put(key, '1', 60);
  return false;
}

function appendRow(sheetName, row) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    SpreadsheetApp.getActive().getSheetByName(sheetName).appendRow(row);
  } finally {
    lock.releaseLock();
  }
}

function firstName(name) {
  return name.split(/\s+/)[0].slice(0, 40);
}

function signature() {
  return 'Kind regards,\n' + MY_NAME + '\nQA & Test Automation Engineer\nhttps://pawansinha.com.au';
}

// A leading ' stops the sheet treating text like "=..." as a formula
function safe(v) {
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
