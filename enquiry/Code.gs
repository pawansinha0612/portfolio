/**
 * Backend for the enquiry form on pawansinha.com.au.
 *
 * Runs as a Google Apps Script web app attached to a Google Sheet. Each submission is
 *   1. added as a row to the "Enquiries" tab,
 *   2. emailed to OWNER_EMAIL (hit Reply to answer the visitor directly),
 *   3. acknowledged with a short confirmation email to the visitor.
 *
 * Run setup() once from the editor, then deploy as a web app (Execute as: Me, Who has access: Anyone)
 * and paste the /exec URL into data-endpoint on the form in docs/index.html.
 */

const OWNER_EMAIL = 'pawansinha4u@gmail.com';
const MY_NAME = 'Pawan Sinha';
const SHEET_NAME = 'Enquiries';
const FIELDS = ['name', 'email', 'company', 'need', 'website', 'timeline', 'message'];
const HEADERS = ['received', ...FIELDS, 'page', 'status'];

function setup() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange(2, HEADERS.length, sh.getMaxRows() - 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['New', 'Replied', 'Call booked', 'Won', 'Lost', 'Spam']).build());
}

// Lets you open the /exec URL in a browser to confirm the deployment is live
function doGet() {
  return json({ ok: true, service: 'enquiry form' });
}

function doPost(e) {
  const p = (e && e.parameter) || {};

  // Honeypot: the field is hidden from people, so anything in it came from a bot.
  // Reply "ok" so the bot moves on.
  if (p.company_site) return json({ ok: true });

  const d = {};
  FIELDS.forEach(f => { d[f] = String(p[f] || '').trim().slice(0, f === 'message' ? 3000 : 200); });
  if (!d.name || !d.message || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) {
    return json({ ok: false, error: 'Please add your name, a valid email and a short message.' });
  }

  // Ignore double-clicks and repeat sends from the same address for a minute
  const cache = CacheService.getScriptCache();
  const key = 'sent:' + d.email.toLowerCase();
  if (cache.get(key)) return json({ ok: true });
  cache.put(key, '1', 60);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // A leading ' stops the sheet treating text like "=..." as a formula
    const row = [new Date(), ...FIELDS.map(f => safe(d[f])), safe(String(p.page || '').slice(0, 300)), 'New'];
    SpreadsheetApp.getActive().getSheetByName(SHEET_NAME).appendRow(row);
  } finally {
    lock.releaseLock();
  }

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

  const first = d.name.split(/\s+/)[0].slice(0, 40);
  MailApp.sendEmail({
    to: d.email,
    name: MY_NAME,
    replyTo: OWNER_EMAIL,
    subject: "Thanks for getting in touch",
    body: 'Hi ' + first + ',\n\n' +
      "Thanks for your message. I've received it and will reply within one business day.\n\n" +
      'If anything is urgent, just reply to this email.\n\n' +
      'Kind regards,\n' + MY_NAME + '\nQA & Test Automation Engineer\nhttps://pawansinha.com.au',
  });

  return json({ ok: true });
}

function safe(v) {
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
