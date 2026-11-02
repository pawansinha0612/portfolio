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
// The live /exec URL, used in unsubscribe links. ScriptApp.getService().getUrl() can return the private /dev URL
// when the Sunday trigger runs, which subscribers can't open. Keep this in sync with data-endpoint in docs/.
const WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbzvFENGzJ59oV9fx3Vc6CFzkjVpv5uFCx3Ob4zp_gfw0tNCXCI8TQYwJ9zQfkHQrARF/exec';

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

  sendWelcome(email, token, '');
  return json({ ok: true });
}

function unsubscribeFooter(token) {
  return "You're getting this because you subscribed at pawansinha.com.au.\n" +
    'Unsubscribe with one click: ' + WEB_APP_URL + '?unsubscribe=' + encodeURIComponent(token);
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
    '<div style="font:17px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:' + EMAIL.text + ';max-width:560px;margin:60px auto;padding:0 16px">' +
    '<p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:' + EMAIL.accent + '">Pawan Sinha · Weekly deep dive</p>' +
    '<h2 style="margin:0 0 12px">' + (done ? "You're unsubscribed" : 'Link not recognised') + '</h2><p>' + msg + '</p>' +
    '<p><a href="' + SITE_URL + '/blog/" style="color:' + EMAIL.accent + ';font-weight:600">Back to the blog →</a></p></div>')
    .setTitle('Unsubscribe');
}

// Runs every Sunday (see installWeeklyDigest). Emails active subscribers the posts published in the last 7 days.
// Skips the week quietly when there are no new posts. To see what subscribers get, run previewDigest() or
// previewWelcome() from the editor: they email only you.
function sendWeeklyDigest() {
  const posts = recentPosts(7);
  if (!posts.length) return;
  const sh = SpreadsheetApp.getActive().getSheetByName(SUBSCRIBER_SHEET);
  if (!sh) return;
  const col = h => SUBSCRIBER_HEADERS.indexOf(h);
  const active = sh.getDataRange().getValues().slice(1).filter(r => r[col('status')] === 'Active' && EMAIL_RE.test(r[col('email')]));
  let sent = 0;
  for (const r of active) {
    if (MailApp.getRemainingDailyQuota() < 5) break;  // keep a few emails for enquiry notifications
    sendDigestTo(String(r[col('email')]), posts, r[col('token')], '');
    sent++;
  }
  if (sent < active.length) {
    MailApp.sendEmail({ to: OWNER_EMAIL, subject: 'Weekly digest: daily email limit reached',
      body: 'Sent ' + sent + ' of ' + active.length + ' digests. Google limits how many emails a script can send per day. ' +
        'Run sendWeeklyDigest again tomorrow from the Apps Script editor to send the rest (people already emailed will get it twice), ' +
        'or move to a mailing service once the list grows.' });
  }
}

// Emails you the digest as subscribers would see it: this week's posts, or the latest 3 if there are none yet.
function previewDigest() {
  const posts = recentPosts(7);
  sendDigestTo(OWNER_EMAIL, posts.length ? posts : latestPosts(3), 'preview', '[Preview] ');
}

// Emails you the welcome email a new subscriber gets.
function previewWelcome() {
  sendWelcome(OWNER_EMAIL, 'preview', '[Preview] ');
}

// ----- HTML emails -----
// Email apps strip JavaScript, so "interactive" means clickable cards and buttons into the live site.
// Tables and inline styles keep the layout intact in Gmail, Outlook and Apple Mail. Every email also has a plain-text part.
const EMAIL = { bg: '#f3f5f9', card: '#ffffff', text: '#121620', muted: '#5a6273', border: '#e3e6ec',
  accent: '#2557d6', accent2: '#12a77a', font: "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif" };
const BOOKING_URL = 'https://calendly.com/pawansinha4u/30min';
const TOOL_LINKS = [
  ['Capacity planner', '/tools/#capacity'], ['Thread pool sizing', '/tools/#thread-pool'],
  ['Coordinated omission', '/tools/#coordinated-omission'], ['Bottleneck finder', '/tools/#bottleneck'],
];

function sendDigestTo(to, posts, token, prefix) {
  const subject = posts.length === 1 ? posts[0].title : posts[0].title + ' (+' + (posts.length - 1) + ' more)';
  const heading = posts.length === 1 ? "This week's deep dive" : "This week's " + posts.length + ' deep dives';
  const html = emailShell({
    preheader: posts.map(p => p.title).join(' · '),
    eyebrow: 'Weekly deep dive · ' + weekLabel(posts),
    heading: heading,
    intro: 'Performance engineering for people who already know the basics. Each post has an interactive calculator you can try with your own numbers.',
    body: postCards(posts) + toolsBlock() + callBlock(),
    token: token,
  });
  const text = 'Hi,\n\n' + heading + ':\n\n' + posts.map(p => '- ' + p.title + '\n  ' + p.summary + '\n  ' + p.link).join('\n\n') +
    '\n\nFree performance calculators: ' + SITE_URL + '/tools/\n\n' + signature() + '\n\n' + unsubscribeFooter(token);
  MailApp.sendEmail({ to: to, name: MY_NAME, replyTo: OWNER_EMAIL, subject: prefix + subject, body: text, htmlBody: html });
}

function sendWelcome(to, token, prefix) {
  let latest = [];
  try { latest = latestPosts(3); } catch (err) {}  // the welcome still goes out if the feed can't be read
  const html = emailShell({
    preheader: "You're in. One short email every Sunday with the week's performance deep dives.",
    eyebrow: 'Welcome',
    heading: "You're subscribed 🎉",
    intro: "Every Sunday morning you'll get one short email with that week's posts: bottlenecks, load testing, caching, " +
      'databases, cloud and more. Each one comes with an interactive calculator.' + (latest.length ? ' Start with the latest:' : ''),
    body: (latest.length ? postCards(latest) : '') + toolsBlock() + callBlock(),
    token: token,
  });
  const text = 'Hi,\n\n' +
    "Thanks for subscribing. Every Sunday morning you'll get a short email with that week's posts on performance " +
    'engineering: bottlenecks, load testing, caching, databases, cloud and more, each with an interactive calculator.\n\n' +
    'Catch up on everything so far: ' + SITE_URL + '/blog/\n' +
    'Free performance calculators: ' + SITE_URL + '/tools/\n\n' +
    signature() + '\n\n' + unsubscribeFooter(token);
  MailApp.sendEmail({ to: to, name: MY_NAME, replyTo: OWNER_EMAIL,
    subject: (prefix || '') + "You're subscribed: one performance deep dive a week", body: text, htmlBody: html });
}

function emailShell(o) {
  const E = EMAIL;
  const unsub = WEB_APP_URL + '?unsubscribe=' + encodeURIComponent(o.token);
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light"></head>' +
    '<body style="margin:0;padding:0;background:' + E.bg + '">' +
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0">' + esc(o.preheader) + '</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + E.bg + '"><tr><td align="center" style="padding:24px 12px">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;font-family:' + E.font + ';color:' + E.text + '">' +
    // brand bar
    '<tr><td style="padding:0 4px 14px"><a href="' + SITE_URL + '" style="text-decoration:none;color:' + E.text + ';font-weight:800;font-size:17px">Pawan Sinha</a>' +
    '<span style="color:' + E.muted + ';font-size:13px"> · Performance &amp; QA engineering</span></td></tr>' +
    // hero card
    '<tr><td style="background:' + E.card + ';border:1px solid ' + E.border + ';border-radius:16px;overflow:hidden">' +
    '<div style="height:6px;background:' + E.accent + ';background-image:linear-gradient(90deg,' + E.accent + ',' + E.accent2 + ')"></div>' +
    '<div style="padding:26px 28px 8px">' +
    '<p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:' + E.accent + '">' + esc(o.eyebrow) + '</p>' +
    '<h1 style="margin:0 0 10px;font-size:26px;line-height:1.25">' + esc(o.heading) + '</h1>' +
    '<p style="margin:0 0 6px;font-size:16px;line-height:1.6;color:' + E.muted + '">' + esc(o.intro) + '</p></div>' +
    '<div style="padding:8px 28px 28px">' + o.body + '</div></td></tr>' +
    // footer
    '<tr><td style="padding:22px 8px;font-size:13px;line-height:1.6;color:' + E.muted + ';text-align:center">' +
    'Pawan Sinha · QA &amp; performance engineer, Melbourne · <a href="mailto:hello@pawansinha.com.au" style="color:' + E.muted + '">hello@pawansinha.com.au</a><br>' +
    "You're getting this because you subscribed at pawansinha.com.au. Reply any time, I read every email.<br>" +
    '<a href="' + unsub + '" style="color:' + E.muted + ';text-decoration:underline">Unsubscribe with one click</a> · ' +
    '<a href="' + SITE_URL + '/blog/" style="color:' + E.muted + '">All posts</a> · ABN 43 627 514 346</td></tr>' +
    '</table></td></tr></table></body></html>';
}

// First post as a large card with its share image, the rest as compact cards with a thumbnail.
function postCards(posts) {
  const E = EMAIL;
  return posts.map((p, i) => {
    const img = p.link.replace(/\/?$/, '/') + 'og.png';
    const button = '<a href="' + p.link + '" style="display:inline-block;background:' + E.accent + ';color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:11px 20px;border-radius:10px">Read the deep dive →</a>';
    if (i === 0) {
      return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 8px;border:1px solid ' + E.border + ';border-radius:14px;overflow:hidden">' +
        '<tr><td><a href="' + p.link + '"><img src="' + img + '" width="100%" alt="' + esc(p.title) + '" style="display:block;width:100%;max-width:544px;height:auto;border:0"></a></td></tr>' +
        '<tr><td style="padding:18px 20px 20px">' +
        (p.date ? '<p style="margin:0 0 6px;font-size:13px;color:' + E.muted + '">' + esc(dayLabel(p.date)) + '</p>' : '') +
        '<h2 style="margin:0 0 8px;font-size:21px;line-height:1.3"><a href="' + p.link + '" style="color:' + E.text + ';text-decoration:none">' + esc(p.title) + '</a></h2>' +
        '<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:' + E.muted + '">' + esc(p.summary) + '</p>' + button + '</td></tr></table>';
    }
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0;border:1px solid ' + E.border + ';border-radius:14px">' +
      '<tr><td width="104" valign="top" style="padding:14px 0 14px 14px"><a href="' + p.link + '"><img src="' + img + '" width="90" alt="" style="display:block;width:90px;height:auto;border:0;border-radius:8px"></a></td>' +
      '<td valign="top" style="padding:14px 16px 14px 14px">' +
      (p.date ? '<p style="margin:0 0 4px;font-size:12px;color:' + E.muted + '">' + esc(dayLabel(p.date)) + '</p>' : '') +
      '<p style="margin:0 0 6px;font-size:16px;font-weight:700;line-height:1.35"><a href="' + p.link + '" style="color:' + E.text + ';text-decoration:none">' + esc(p.title) + '</a></p>' +
      '<p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:' + E.muted + '">' + esc(shorten(p.summary, 140)) + '</p>' +
      '<a href="' + p.link + '" style="font-size:14px;font-weight:700;color:' + E.accent + ';text-decoration:none">Read →</a></td></tr></table>';
  }).join('');
}

function toolsBlock() {
  const E = EMAIL;
  const pills = TOOL_LINKS.map(t => '<a href="' + SITE_URL + t[1] + '" style="display:inline-block;margin:0 6px 8px 0;padding:8px 14px;border:1px solid ' + E.border +
    ';border-radius:999px;background:#f7f9fc;color:' + E.text + ';text-decoration:none;font-size:14px;font-weight:600">' + esc(t[0]) + ' →</a>').join('');
  return '<div style="margin:22px 0 0;padding:18px 20px;border-radius:14px;background:#eef3ff">' +
    '<p style="margin:0 0 4px;font-size:16px;font-weight:700">🧮 Try it with your own numbers</p>' +
    '<p style="margin:0 0 12px;font-size:14px;line-height:1.5;color:' + E.muted + '">Free calculators: drag the sliders and watch latency, capacity and queues change.</p>' + pills + '</div>';
}

function callBlock() {
  const E = EMAIL;
  return '<div style="margin:14px 0 0;padding:18px 20px;border-radius:14px;border:1px solid ' + E.border + '">' +
    '<p style="margin:0 0 4px;font-size:16px;font-weight:700">Big launch or peak season coming up?</p>' +
    '<p style="margin:0 0 12px;font-size:14px;line-height:1.5;color:' + E.muted + '">I run load tests that show how much traffic you can really take, and what to fix first.</p>' +
    '<a href="' + BOOKING_URL + '" style="display:inline-block;background:' + E.accent2 + ';color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 18px;border-radius:10px">Book a free 30-minute call</a></div>';
}

function weekLabel(posts) {
  const d = posts.map(p => p.date).filter(Boolean);
  if (!d.length) return Utilities.formatDate(new Date(), 'Australia/Melbourne', 'd MMMM yyyy');
  const f = x => Utilities.formatDate(x, 'Australia/Melbourne', 'd MMM');
  return d.length === 1 ? f(d[0]) : f(d[0]) + ' – ' + f(d[d.length - 1]);
}

function dayLabel(date) {
  return Utilities.formatDate(date, 'Australia/Melbourne', 'EEEE d MMMM');
}

function shorten(t, n) {
  t = String(t || '');
  return t.length <= n ? t : t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…';
}

function esc(t) {
  return String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function latestPosts(n) {
  return allPosts().slice(-n);
}

function recentPosts(days) {
  const since = Date.now() - days * 24 * 3600 * 1000;
  return allPosts().filter(p => p.date.getTime() > since);
}

// Published posts from the RSS feed, oldest first.
function allPosts() {
  const xml = UrlFetchApp.fetch(FEED_URL, { muteHttpExceptions: true }).getContentText();
  const items = XmlService.parse(xml).getRootElement().getChild('channel').getChildren('item');
  return items
    .map(it => ({
      title: it.getChildText('title'),
      link: it.getChildText('link'),
      summary: it.getChildText('description'),
      date: new Date(it.getChildText('pubDate')),
    }))
    .filter(p => p.date.getTime() <= Date.now())
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
