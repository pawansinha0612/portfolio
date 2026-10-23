/**
 * Availability notifier for Google Sheets.
 *
 * Paste into Extensions > Apps Script of a new Google Sheet, save, reload the sheet,
 * then use the "Availability" menu. Mail goes out through your own Google account
 * (MailApp, send-only permission), so no password is stored anywhere.
 *
 * Tabs:
 *   Profile   key | value. Edit for each new contract. Any key can be used as {key}
 *             in subject/body. Changing contract_end_date starts a new campaign.
 *   Contacts  name | first_name | email | tags (separated by ;) | personal_note | opt_out
 *   Sent      campaign | email | name | sent_at. Nobody is emailed twice per campaign.
 *   Found     people pulled from Gmail by "Import job contacts". Tick keep, then
 *             "Move ticked Found rows to Contacts". Optional Profile key gmail_search
 *             overrides the search used.
 */

const PROFILE = 'Profile';
const CONTACTS = 'Contacts';
const SENT = 'Sent';
const FOUND = 'Found';
const MAX_THREADS = 1000;

const DEFAULT_GMAIL_SEARCH =
  'newer_than:3y -category:promotions -category:social -category:forums ' +
  '(recruiter OR recruitment OR recruiting OR "talent acquisition" OR "job opportunity" OR ' +
  'opportunity OR role OR position OR contract OR contractor OR interview OR CV OR resume OR ' +
  '"performance test" OR "performance testing" OR "performance engineer" OR "load testing" OR ' +
  'QA OR "quality assurance" OR tester OR testing OR "test automation" OR "test lead" OR ' +
  'JMeter OR LoadRunner OR k6 OR Playwright)';

// Senders that are never a person worth emailing.
const SKIP_SENDER = /(no-?reply|do-?not-?reply|notification|mailer-daemon|postmaster|alerts?@|jobs?@|careers?@|news(letter)?@|marketing@|info@|support@|hello@|team@|calendar|invitations?@|bounce)/i;
const SKIP_DOMAIN = /(linkedin\.com|seek\.com\.au|indeed\.|glassdoor\.|google\.com|facebookmail\.com|github\.com|atlassian\.net|slack\.com|zoom\.us|microsoft\.com|upwork\.com|calendly\.com)$/i;
const FREE_MAIL = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|bigpond|optusnet)\./i;
const RECRUITER_HINT = /(recruit|talent|staffing|people|hays|randstad|hudson|robert ?walters|michael ?page|peoplebank|paxus|davidson|sharp ?& ?carter|halcyon|finite|talent ?international|aurec|clicks|bluefin|fourquarters|charterhouse)/i;

// Phone contacts are often saved like "Rahul Hays Recruiter" or "Priya ANZ Testing", so
// these are matched against name, company, job title and notes.
const JOB_WORDS = /(recruit|talent|hiring|headhunt|agency|consult|contract|vendor|client|interview|\bjobs?\b|office|work\b|colleague|manager|\blead\b|director|architect|engineer|developer|\bdev\b|test|\bqa\b|quality|performance|automation|scrum|agile|delivery|project|programme|program|analyst|devops|\btech|software|\bsdet\b|\banz\b|\bnab\b|\bcba\b|commbank|westpac|\bvisa\b|mastercard|lottery|\btlc\b|tabcorp|telstra|optus|infosys|\btcs\b|wipro|accenture|cognizant|capgemini|\bhcl\b|mahindra|\bibm\b|deloitte|kpmg|\bpwc\b|\bdxc\b|\bntt\b|mphasis|mindtree|synechron|virtusa|planit|\bhays\b|randstad|hudson (rpo|global)|robert ?walters|michael ?page|peoplebank|paxus|davidson (wp|recruit)|sharp ?& ?carter|halcyon|finite (it|group)|aurec|clicks it|bluefin|fourquarters|charterhouse|chandler macleod|people2people|hcltech)/i;
// Short all-caps tags, matched case-sensitively so "it" or "ey" inside normal words don't count.
const JOB_CAPS = /\b(HR|IT|QA|PM|BA|EY|TL)\b/;
const SECONDS_BETWEEN_EMAILS = 2;

const DEFAULT_PROFILE = [
  ['my_name', 'Pawan Sinha'],
  ['headline', 'QA & Test Automation Engineer with 12+ years across banking, payments and gaming (ANZ, NAB, Visa, The Lottery Corporation)'],
  ['skills', 'manual and functional testing, API testing, Playwright test automation, and specialist performance and load testing (k6, JMeter, LoadRunner)'],
  ['website', 'https://pawansinha.com.au/'],
  ['linkedin', 'https://www.linkedin.com/in/pawan-sinha-b5a356b6/'],
  ['upwork', 'https://www.upwork.com/freelancers/~015b09c42e9ca95fc9'],
  ['phone', ''],
  ['contract_end_date', '2026-12-19'],
  ['available_from', '2026-12-22'],
  ['test_email', ''],
  ['subject', '{my_name} — available for contract work from {available_from}'],
  ['body', [
    'Hi {first_name},',
    '',
    "{personal_note}I hope you're doing well. A quick heads-up: my current contract wraps up soon and I'm available for new work from {available_from}.",
    '',
    'I work as a {headline}. Areas I can help with: {skills}.',
    '',
    "If you or anyone in your network needs help, I'd really appreciate a reply or an introduction. Happy to share a CV or jump on a quick call.",
    '',
    'Portfolio: {website}',
    'LinkedIn:  {linkedin}',
    'Upwork:    {upwork}',
    '',
    'Thanks,',
    '{my_name}',
    '{phone}',
    '',
    "(If you'd rather not get these updates, just reply and let me know.)",
  ].join('\n')],
];

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Availability')
    .addItem('1. Send test email to me', 'sendTest')
    .addItem('2. Send to everyone not yet emailed', 'sendAll')
    .addItem('2b. Send to one tag only (e.g. recruiter)', 'sendTag')
    .addSeparator()
    .addItem('Import job contacts from Gmail', 'importFromGmail')
    .addItem('Import from Google Contacts', 'importFromGoogleContacts')
    .addItem('Move ticked Found rows to Contacts (also done by step 1)', 'moveFoundToContacts')
    .addSeparator()
    .addItem('Status', 'showStatus')
    .addItem('Set up tabs', 'setup')
    .addToUi();
}

function setup() {
  const ss = SpreadsheetApp.getActive();
  if (!ss.getSheetByName(PROFILE)) {
    const sh = ss.insertSheet(PROFILE);
    sh.getRange('A:B').setNumberFormat('@'); // plain text, so dates stay yyyy-mm-dd
    sh.getRange(1, 1, 1, 2).setValues([['key', 'value']]).setFontWeight('bold');
    sh.getRange(2, 1, DEFAULT_PROFILE.length, 2).setValues(DEFAULT_PROFILE).setWrap(true);
    sh.setColumnWidth(1, 160).setColumnWidth(2, 700);
  }
  if (!ss.getSheetByName(CONTACTS)) {
    const sh = ss.insertSheet(CONTACTS);
    sh.getRange(1, 1, 1, 6)
      .setValues([['name', 'first_name', 'email', 'tags', 'personal_note', 'opt_out']])
      .setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  if (!ss.getSheetByName(SENT)) {
    const sh = ss.insertSheet(SENT);
    sh.getRange(1, 1, 1, 4).setValues([['campaign', 'email', 'name', 'sent_at']]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  const blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  SpreadsheetApp.getUi().alert('Tabs ready. Fill in Profile and Contacts, then run "1. Send test email to me".');
}

// ---- data -------------------------------------------------------------------

function loadProfile() {
  const sh = SpreadsheetApp.getActive().getSheetByName(PROFILE);
  if (!sh) throw new Error('No Profile tab. Run Availability > Set up tabs.');
  const tz = Session.getScriptTimeZone();
  const p = {};
  sh.getDataRange().getValues().slice(1).forEach(([k, v]) => {
    if (!k) return;
    p[String(k).trim()] = v instanceof Date ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : String(v);
  });
  if (!p.contract_end_date) throw new Error('Profile is missing contract_end_date.');
  p.campaign = p.contract_end_date;
  const avail = p.available_from || p.contract_end_date;
  p.available_from = Utilities.formatDate(new Date(avail + 'T12:00:00'), tz, 'd MMMM yyyy');
  p.test_email = p.test_email || Session.getEffectiveUser().getEmail();
  return p;
}

function loadContacts(tag) {
  const sh = SpreadsheetApp.getActive().getSheetByName(CONTACTS);
  const [head, ...rows] = sh.getDataRange().getValues();
  const idx = name => head.map(h => String(h).trim().toLowerCase()).indexOf(name);
  const col = (r, name) => (idx(name) < 0 ? '' : String(r[idx(name)] || '').trim());
  return rows
    .map(r => ({
      name: col(r, 'name'),
      first_name: col(r, 'first_name'),
      email: col(r, 'email'),
      tags: col(r, 'tags').toLowerCase().split(';').map(t => t.trim()).filter(Boolean),
      personal_note: col(r, 'personal_note'),
      opt_out: ['y', 'yes', 'true', '1'].includes(col(r, 'opt_out').toLowerCase()),
    }))
    .filter(c => c.email && !c.opt_out && (!tag || c.tags.includes(tag.toLowerCase())));
}

function sentEmails(campaign) {
  const rows = SpreadsheetApp.getActive().getSheetByName(SENT).getDataRange().getValues().slice(1);
  return new Set(rows.filter(r => String(r[0]) === campaign).map(r => String(r[1]).toLowerCase()));
}

function render(p, c) {
  const values = Object.assign({}, p, {
    first_name: (c.first_name || c.name || 'there').split(' ')[0],
    personal_note: c.personal_note ? c.personal_note + '\n\n' : '',
  });
  const fill = s => s.replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m));
  return { subject: fill(p.subject), body: fill(p.body).replace(/\n{3,}/g, '\n\n').trim() + '\n' };
}

// A fingerprint of everything that changes the email, so "send to everyone" only
// unlocks after you have test-sent the exact current version to yourself.
function fingerprint(p) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(p));
  return Utilities.base64Encode(bytes);
}

// ---- menu actions -----------------------------------------------------------

function sendTest() {
  const moved = moveTicked_();
  const p = loadProfile();
  const sample = loadContacts()[0] || { name: 'Sample Recruiter', first_name: 'Sample', personal_note: 'It was great catching up last month.' };
  const { subject, body } = render(p, sample);
  MailApp.sendEmail({ to: p.test_email, subject: '[TEST] ' + subject, body: body, name: p.my_name });
  PropertiesService.getDocumentProperties().setProperty('testedFingerprint', fingerprint(p));
  SpreadsheetApp.getUi().alert(
    (moved.moved ? 'Moved ' + moved.moved + ' ticked people from Found to Contacts.\n' : '') +
    (moved.noEmail ? moved.noEmail + ' ticked Found row(s) have no email and were skipped.\n' : '') +
    'Contacts now: ' + loadContacts().length + ' people.\n\n' +
    'Test sent to ' + p.test_email + ' (rendered as if to ' + (sample.email || sample.name) + ').\n\n' +
    'Check it, then run "2. Send to everyone". If you edit Profile, send a new test first.');
}

function sendAll() { send_(''); }

function sendTag() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Send to one tag', 'Tag (e.g. recruiter):', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK || !res.getResponseText().trim()) return;
  send_(res.getResponseText().trim());
}

function send_(tag) {
  const ui = SpreadsheetApp.getUi();
  const p = loadProfile();
  if (PropertiesService.getDocumentProperties().getProperty('testedFingerprint') !== fingerprint(p)) {
    ui.alert('Profile changed since your last test (or no test yet). Run "1. Send test email to me" first.');
    return;
  }
  const done = sentEmails(p.campaign);
  const pending = loadContacts(tag).filter(c => !done.has(c.email.toLowerCase()));
  if (!pending.length) {
    ui.alert('Everyone' + (tag ? ' tagged "' + tag + '"' : '') + ' has already been emailed for the contract ending ' + p.campaign + '.');
    return;
  }
  const quota = MailApp.getRemainingDailyQuota();
  const ok = ui.alert('Confirm',
    'Send to ' + pending.length + ' contact(s)' + (tag ? ' tagged "' + tag + '"' : '') +
    ' for the contract ending ' + p.campaign + '?\n\nGoogle allows ' + quota + ' more today; any left over can be sent tomorrow with the same menu item.',
    ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;

  const log = SpreadsheetApp.getActive().getSheetByName(SENT);
  const failed = [];
  let count = 0;
  for (const c of pending) {
    if (MailApp.getRemainingDailyQuota() < 1) break;
    const { subject, body } = render(p, c);
    try {
      MailApp.sendEmail({ to: c.email, subject: subject, body: body, name: p.my_name });
    } catch (e) {
      failed.push(c.email + ': ' + e.message);
      continue;
    }
    log.appendRow([p.campaign, c.email.toLowerCase(), c.name, new Date()]);
    SpreadsheetApp.flush(); // record each one so a timeout never causes a duplicate
    count++;
    Utilities.sleep(SECONDS_BETWEEN_EMAILS * 1000);
  }
  const left = pending.length - count - failed.length;
  ui.alert('Sent ' + count + ' of ' + pending.length + '.' +
    (left ? '\n' + left + ' not sent yet (daily limit or time limit). Run the same menu item again later.' : '') +
    (failed.length ? '\n\nFailed:\n' + failed.join('\n') : ''));
}

function showStatus() {
  const p = loadProfile();
  const all = loadContacts();
  const done = sentEmails(p.campaign);
  const daysLeft = Math.ceil((new Date(p.campaign + 'T12:00:00') - new Date()) / 86400000);
  const tested = PropertiesService.getDocumentProperties().getProperty('testedFingerprint') === fingerprint(p);
  SpreadsheetApp.getUi().alert(
    'Contract ends: ' + p.campaign + ' (' + daysLeft + ' days left)\n' +
    'Available from: ' + p.available_from + '\n' +
    'Contacts: ' + all.length + ' active, ' + all.filter(c => done.has(c.email.toLowerCase())).length + ' emailed for this contract\n' +
    'Test email for current Profile: ' + (tested ? 'sent' : 'NOT sent yet') + '\n' +
    'Daily send quota left: ' + MailApp.getRemainingDailyQuota());
}

// ---- import from Gmail and Google Contacts ---------------------------------

const TIME_BUDGET_MS = 4.5 * 60 * 1000; // Google stops scripts at 6 minutes; save before that
const FOUND_HEADER = ['keep', 'name', 'first_name', 'email', 'company', 'tags',
  'emails', 'you_replied', 'last_contact', 'last_subject', 'phone', 'source'];

function parseAddresses(header) {
  const out = [];
  String(header || '').split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).forEach(part => {
    const m = part.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/) || part.match(/^\s*()([^\s<>]+@[^\s<>]+)\s*$/);
    if (m) out.push({ name: m[1].trim(), email: m[2].trim().toLowerCase() });
  });
  return out;
}

// Emails (and, for email-less rows, names) already in Contacts or Found, so imports never duplicate.
function knownKeys_() {
  const known = new Set();
  [CONTACTS, FOUND].forEach(name => {
    const sh = SpreadsheetApp.getActive().getSheetByName(name);
    if (!sh) return;
    const [head, ...rows] = sh.getDataRange().getValues();
    const h = head.map(x => String(x).toLowerCase());
    const e = h.indexOf('email'), n = h.indexOf('name');
    rows.forEach(r => {
      if (e >= 0 && r[e]) known.add(String(r[e]).trim().toLowerCase());
      else if (n >= 0 && r[n]) known.add('name:' + String(r[n]).trim().toLowerCase());
    });
  });
  return known;
}

function appendFound_(rows) {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(FOUND) || ss.insertSheet(FOUND);
  sh.getRange(1, 1, 1, FOUND_HEADER.length).setValues([FOUND_HEADER]).setFontWeight('bold');
  sh.setFrozenRows(1);
  if (!rows.length) return;
  const start = sh.getLastRow() + 1;
  sh.getRange(start, 11, rows.length, 1).setNumberFormat('@'); // keep leading 0 / + in phone numbers
  sh.getRange(start, 1, rows.length, FOUND_HEADER.length).setValues(rows);
  sh.getRange(start, 1, rows.length, 1).insertCheckboxes();
}

function companyFromEmail_(email) {
  const domain = (email.split('@')[1] || '');
  return FREE_MAIL.test(domain) ? '' : domain.split('.')[0];
}

function importFromGmail() {
  const started = Date.now();
  let query = DEFAULT_GMAIL_SEARCH;
  try { query = loadProfile().gmail_search || query; } catch (e) { /* no Profile yet */ }

  const me = new Set([Session.getEffectiveUser().getEmail()].concat(GmailApp.getAliases()).map(e => e.toLowerCase()));
  const known = knownKeys_();

  const people = {}; // email -> {name, email, count, replied, last, subject, recruiter}
  const add = (addr, msg, fromMe) => {
    const domain = addr.email.split('@')[1] || '';
    if (me.has(addr.email) || known.has(addr.email) || SKIP_SENDER.test(addr.email) || SKIP_DOMAIN.test(domain)) return;
    const p = people[addr.email] || (people[addr.email] = { name: '', email: addr.email, count: 0, replied: false, last: null, subject: '', recruiter: false });
    if (!p.name && addr.name && !addr.name.includes('@')) p.name = addr.name;
    p.count++;
    if (fromMe) p.replied = true;
    if (!p.last || msg.getDate() > p.last) { p.last = msg.getDate(); p.subject = msg.getSubject(); }
    if (RECRUITER_HINT.test(addr.name + ' ' + domain + ' ' + msg.getSubject())) p.recruiter = true;
  };

  let scanned = 0, stoppedEarly = false;
  for (let start = 0; start < MAX_THREADS; start += 50) {
    if (Date.now() - started > TIME_BUDGET_MS) { stoppedEarly = true; break; }
    const threads = GmailApp.search(query, start, 50);
    if (!threads.length) break;
    GmailApp.getMessagesForThreads(threads).forEach(msgs => msgs.forEach(msg => {
      scanned++;
      const from = parseAddresses(msg.getFrom())[0];
      if (!from) return;
      if (me.has(from.email)) {
        // You wrote to them: strongest signal they are a real contact.
        parseAddresses(msg.getTo()).concat(parseAddresses(msg.getCc())).forEach(a => add(a, msg, true));
      } else if (!msg.getHeader('List-Unsubscribe')) { // skip newsletters and job alerts
        add(from, msg, false);
      }
    }));
  }

  const list = Object.values(people).sort((a, b) => (b.replied - a.replied) || (b.count - a.count));
  appendFound_(list.map(p => [p.replied, p.name, p.name.split(/[\s,]+/)[0] || '', p.email,
    companyFromEmail_(p.email), p.recruiter ? 'recruiter' : 'contact', p.count, p.replied ? 'yes' : '',
    p.last, p.subject, '', 'gmail']));
  SpreadsheetApp.getUi().alert('Scanned ' + scanned + ' emails, found ' + list.length + ' new people (added to the Found tab).' +
    (stoppedEarly ? '\n\nStopped early to stay inside Google\'s 6-minute limit. Run it again to continue; people already found are skipped.' : '') +
    '\n\nPeople you emailed are ticked already. Review the list, tick or untick "keep", adjust tags, ' +
    'then run "Move ticked Found rows to Contacts".');
}

// Needs the People API service: Apps Script editor > Services (+) > People API > Add.
function isJobRelated_(text) {
  return JOB_WORDS.test(text) || JOB_CAPS.test(text);
}

// Removes rows an earlier Google Contacts import added, so a re-run applies the current filter.
function clearContactsImport_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(FOUND);
  if (!sh) return;
  const rows = sh.getDataRange().getValues();
  const src = rows[0].map(h => String(h).toLowerCase()).indexOf('source');
  if (src < 0) return;
  for (let i = rows.length - 1; i >= 1; i--) {
    if (String(rows[i][src]).indexOf('google contacts') === 0) sh.deleteRow(i + 1);
  }
}

// Needs the People API service: Apps Script editor > Services (+) > People API > Add.
// Keeps only job-related contacts: a company or job title is saved, the email is a work
// address, or the name or notes mention a job word, employer, agency or testing term.
function importFromGoogleContacts() {
  if (typeof People === 'undefined') {
    SpreadsheetApp.getUi().alert('Turn on the People API first: in the Apps Script editor click Services (+), ' +
      'pick "People API", click Add, save, then run this again.');
    return;
  }
  clearContactsImport_();
  const known = knownKeys_();
  const rows = [];
  let pageToken, total = 0;
  do {
    const res = People.People.Connections.list('people/me', {
      personFields: 'names,emailAddresses,phoneNumbers,organizations,biographies',
      pageSize: 1000, pageToken: pageToken,
    });
    (res.connections || []).forEach(c => {
      total++;
      const name = ((c.names || [])[0] || {}).displayName || '';
      const first = ((c.names || [])[0] || {}).givenName || name.split(' ')[0] || '';
      const email = (((c.emailAddresses || [])[0] || {}).value || '').toLowerCase();
      const phone = ((c.phoneNumbers || [])[0] || {}).value || '';
      const org = (c.organizations || [])[0] || {};
      const note = ((c.biographies || [])[0] || {}).value || '';
      const workEmail = email && !FREE_MAIL.test(email.split('@')[1] || '');
      const company = org.name || (workEmail ? companyFromEmail_(email) : '');
      const key = email || 'name:' + name.toLowerCase();
      if (!name && !email) return;
      if (known.has(key) || (email && (SKIP_SENDER.test(email) || SKIP_DOMAIN.test(email.split('@')[1])))) return;
      const text = [name, org.name || '', org.title || '', org.department || '', note, workEmail ? email : ''].join(' ');
      if (!org.name && !org.title && !workEmail && !isJobRelated_(text)) return;
      known.add(key);
      const recruiter = RECRUITER_HINT.test(text);
      rows.push([!!email, name, first, email, company, recruiter ? 'recruiter' : 'contact',
        '', '', '', org.title || note.slice(0, 80), phone, email ? 'google contacts' : 'google contacts (no email)']);
    });
    pageToken = res.nextPageToken;
  } while (pageToken);

  rows.sort((a, b) => (Number(b[5] === 'recruiter') - Number(a[5] === 'recruiter')) || (Number(!!b[3]) - Number(!!a[3])));
  appendFound_(rows);
  SpreadsheetApp.getUi().alert('Read ' + total + ' saved contacts and kept ' + rows.length + ' job-related ones ' +
    '(company, job title, work email, or a job/company/testing word in the name or notes).\n\n' +
    'Ones with an email are ticked. Phone-only ones are listed for reference; add an email to a row to move it.');
}

// Copies ticked Found rows into Contacts (in Contacts' column order) and removes them from Found.
// Returns {moved, noEmail}. Runs automatically before a test send.
function moveTicked_() {
  const ss = SpreadsheetApp.getActive();
  const found = ss.getSheetByName(FOUND);
  const contacts = ss.getSheetByName(CONTACTS);
  if (!found || !contacts) return { moved: 0, noEmail: 0 };
  const rows = found.getDataRange().getValues();
  const existing = new Set(loadContacts().map(c => c.email.toLowerCase()));
  const toAdd = [];
  let noEmail = 0;
  for (let i = rows.length - 1; i >= 1; i--) { // bottom-up so deleting rows keeps indexes valid
    const [keep, name, first, email, , tags] = rows[i];
    if (keep !== true) continue;
    const addr = String(email).trim();
    if (!addr) { noEmail++; continue; }
    if (!existing.has(addr.toLowerCase())) {
      toAdd.unshift([name, first || String(name).split(' ')[0], addr, tags, '', '']);
      existing.add(addr.toLowerCase());
    }
    found.deleteRow(i + 1);
  }
  if (toAdd.length) contacts.getRange(contacts.getLastRow() + 1, 1, toAdd.length, 6).setValues(toAdd);
  return { moved: toAdd.length, noEmail: noEmail };
}

function moveFoundToContacts() {
  const r = moveTicked_();
  SpreadsheetApp.getUi().alert('Moved ' + r.moved + ' people to Contacts. Unticked rows stay in Found.' +
    (r.noEmail ? '\n' + r.noEmail + ' ticked row(s) have no email and were left in Found; add an email to move them.' : ''));
}
