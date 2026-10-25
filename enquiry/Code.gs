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
 * Run setup() once from the editor, then deploy as a web app (Execute as: Me, Who has access: Anyone)
 * and paste the /exec URL into data-endpoint on the forms in docs/.
 */

const OWNER_EMAIL = 'pawansinha4u@gmail.com';
const MY_NAME = 'Pawan Sinha';

const ENQUIRY_SHEET = 'Enquiries';
const ENQUIRY_FIELDS = ['name', 'email', 'company', 'need', 'website', 'timeline', 'message'];
const ENQUIRY_HEADERS = ['received', ...ENQUIRY_FIELDS, 'page', 'status'];

const TESTIMONIAL_SHEET = 'Testimonials';
const TESTIMONIAL_FIELDS = ['name', 'title', 'company', 'relationship', 'quote', 'email', 'linkedin'];
const TESTIMONIAL_HEADERS = ['received', ...TESTIMONIAL_FIELDS, 'consent', 'approved'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function setup() {
  const enquiries = sheetWithHeaders(ENQUIRY_SHEET, ENQUIRY_HEADERS);
  dropdown(enquiries, ENQUIRY_HEADERS.length, ['New', 'Replied', 'Call booked', 'Won', 'Lost', 'Spam']);
  const testimonials = sheetWithHeaders(TESTIMONIAL_SHEET, TESTIMONIAL_HEADERS);
  dropdown(testimonials, TESTIMONIAL_HEADERS.length, ['Yes', 'No']);
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
  if (e && e.parameter && e.parameter.view === 'testimonials') {
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
