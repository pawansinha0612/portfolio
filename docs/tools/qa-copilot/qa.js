/* QA Manager Copilot: pure, rule-based functions with no DOM. Nothing here calls a server or an AI model.
   Runs in the browser (window.QACopilot) and in Node (module.exports) for the tests in toolkit-tests/qa-copilot.test.js.

   parseRequirements(text)          user stories, acceptance criteria, Gherkin and plain lines → requirements
   detectBoundaries(text)           "between 1 and 100", "max 50 characters", "at least 8" → boundary specs
   generateScenarios(reqs)          requirements → test scenarios (happy, negative, boundary, equivalence, permissions,
                                    empty/null, performance, security, accessibility)
   scenariosToCSV / scenariosToGherkin
   buildStrategy(form)              → Markdown test strategy
   estimate(inputs)                 → three-point (PERT) estimate with breakdown and contingency
   coverage(model), importResults(model, csv), parseCSV(text)
   riskScore(input)                 → release risk score, level, reasons and go/no-go
   buildReport(parts)               → one-page Markdown stakeholder report
   markdownToHtml(md)               → safe HTML for the Markdown this file writes
*/
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ helpers
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s);
  const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : (d || 0); };
  const r1 = n => Math.round(n * 10) / 10;
  const pad = (n, w) => String(n).padStart(w, '0');

  // ------------------------------------------------------------------ requirements
  const ID_RE = /^((?:[A-Z][A-Z0-9]{1,9}-\d+)|(?:(?:REQ|FR|NFR|BR|US|UC)[-_ ]?\d+(?:\.\d+)*))\s*[:.)\]–—-]?\s+/i;
  const BULLET_RE = /^(?:[-*•+]\s+|\d{1,3}[.)]\s+|\[[ x]\]\s+)/i;
  const AC_HEAD_RE = /^(?:acceptance criteri(?:a|on)\s*\d*|criteria|ac\s*\d+|ac(?=\s*[:.)-]))\s*[:.)-]?\s*/i;
  const STORY_RE = /^as an?\s+/i;
  const STORY_PART_RE = /^(?:as an?\b|i want\b|i need\b|i would like\b|i can\b|i should\b|so that\b|in order to\b)/i;
  const GWT_RE = /^(given|when|then|and|but)\b\s*/i;
  const SCEN_RE = /^(scenario outline|scenario template|scenario|example|rule)\s*:\s*/i;
  const FEAT_RE = /^(feature|ability|business need)\s*:\s*/i;

  function parseStory(sentence) {
    const s = sentence.replace(/\s+/g, ' ').trim();
    const m = /^as an?\s+(.+?)[,;]?\s+i\s+(?:want|need|would like|can|should be able)\s+(?:to\s+|be able to\s+)?(.+?)(?:[,;]?\s+(?:so that|in order to)\s+(.+?))?\.?$/i.exec(s);
    if (!m) return { role: '', want: s.replace(STORY_RE, ''), benefit: '' };
    return { role: m[1].trim(), want: m[2].trim(), benefit: (m[3] || '').trim() };
  }

  function parseRequirements(text) {
    const blocks = [];
    let cur = [];
    String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach(raw => {
      const t = raw.trim();
      if (!t) { if (cur.length) blocks.push(cur); cur = []; } else cur.push(t);
    });
    if (cur.length) blocks.push(cur);

    const reqs = [];
    let auto = 0, feature = '', background = [], last = null;
    const nextId = () => { auto++; return 'REQ-' + pad(auto, 3); };
    const takeId = line => {
      const m = ID_RE.exec(line);
      return m ? { id: m[1].toUpperCase().replace(/[_ ]/g, '-'), rest: line.slice(m[0].length).trim() } : { id: '', rest: line };
    };
    const push = r => { r.id = r.id || nextId(); r.group = r.group || feature; reqs.push(r); last = r; return r; };

    for (const block of blocks) {
      const lines = block.map(l => l.replace(BULLET_RE, '').trim()).filter(Boolean);
      const first = lines[0];
      const firstId = takeId(first);

      // Gherkin: Feature / Background / Scenario anywhere in the block
      if (lines.some(l => FEAT_RE.test(l) || SCEN_RE.test(l) || /^background\s*:/i.test(l))) {
        let scen = null, inBackground = false;
        for (const l of lines) {
          if (FEAT_RE.test(l)) { feature = l.replace(FEAT_RE, '').trim(); scen = null; inBackground = false; continue; }
          if (/^background\s*:/i.test(l)) { inBackground = true; background = []; scen = null; continue; }
          if (SCEN_RE.test(l)) {
            inBackground = false;
            const t = takeId(l.replace(SCEN_RE, ''));
            scen = push({ id: t.id, type: 'gherkin', title: t.rest || 'Scenario', text: t.rest, criteria: [], steps: { given: background.slice(), when: [], then: [] } });
            continue;
          }
          const g = GWT_RE.exec(l);
          if (g) {
            const kw = g[1].toLowerCase(), body = l.slice(g[0].length).trim();
            if (inBackground) { background.push(body); continue; }
            if (!scen) scen = push({ id: '', type: 'gherkin', title: feature || 'Scenario', text: '', criteria: [], steps: { given: background.slice(), when: [], then: [] } });
            const st = scen.steps;
            const slot = kw === 'given' ? 'given' : kw === 'when' ? 'when' : kw === 'then' ? 'then'
              : (st.then.length ? 'then' : st.when.length ? 'when' : 'given');
            st[slot].push(body);
            scen.text = (scen.text + ' ' + body).trim();
            continue;
          }
          if (/^(examples|scenarios)\s*:/i.test(l) || l.startsWith('|') || l.startsWith('@') || l.startsWith('#')) continue;
          if (scen) scen.text = (scen.text + ' ' + l).trim();
          else if (inBackground) background.push(l);
        }
        continue;
      }

      // User story ("As a … I want … so that …"), optionally with an ID in front
      if (STORY_RE.test(firstId.rest)) {
        const storyLines = [firstId.rest];
        let i = 1;
        while (i < lines.length && STORY_PART_RE.test(lines[i]) && !STORY_RE.test(lines[i])) storyLines.push(lines[i++]);
        const sentence = storyLines.join(' ');
        const st = parseStory(sentence);
        const r = push({ id: firstId.id, type: 'story', title: sentence, text: sentence, role: st.role, want: st.want, benefit: st.benefit, criteria: [], steps: null });
        addCriteria(r, lines.slice(i));
        continue;
      }

      // Acceptance criteria or Given/When/Then lines that follow a story in their own block
      const isAcHead = /^(?:acceptance criteri(?:a|on)|criteria)\s*:?\s*$/i.test(first) || /^ac\s*\d+\s*[:.)-]/i.test(first);
      const allBullets = block.every(l => BULLET_RE.test(l));
      if (last && last.type === 'story' && (isAcHead || GWT_RE.test(first) || allBullets)) {
        addCriteria(last, lines);
        continue;
      }

      // Anything else: one requirement per line; markdown headings and "Something:" lines name the group
      for (const l of lines) {
        if (/^#{1,6}\s/.test(l)) { feature = l.replace(/^#+\s*/, ''); continue; }
        if (/:$/.test(l) && l.length < 60 && !/must|should|shall/i.test(l)) { feature = l.replace(/:$/, ''); continue; }
        const t = takeId(l);
        const body = t.rest.replace(/^(?:requirement|req)\s*[:.-]\s*/i, '');
        if (!body) continue;
        push({ id: t.id, type: /\b(must|shall|should|will|needs? to|is required to)\b/i.test(body) ? 'statement' : 'line', title: body, text: body, criteria: [], steps: null });
      }
    }
    // keep IDs unique
    const seen = {};
    reqs.forEach(r => { if (seen[r.id]) { seen[r.id]++; r.id = r.id + '.' + seen[r.id]; } else seen[r.id] = 1; });
    return reqs;

    function addCriteria(r, ls) {
      for (const l of ls) {
        const g = GWT_RE.exec(l);
        if (g && r.type === 'story') {
          r.gwt = r.gwt || { given: [], when: [], then: [] };
          const kw = g[1].toLowerCase(), body = l.slice(g[0].length).trim();
          const slot = kw === 'given' || kw === 'when' || kw === 'then' ? kw : (r.gwt.then.length ? 'then' : r.gwt.when.length ? 'when' : 'given');
          r.gwt[slot].push(body);
          if (slot === 'then') r.criteria.push((r.gwt.given.length ? 'Given ' + r.gwt.given.join(' and ') + ', ' : '') + (r.gwt.when.length ? 'when ' + r.gwt.when.join(' and ') + ', ' : '') + 'then ' + body);
          continue;
        }
        const c = l.replace(AC_HEAD_RE, '').trim();
        if (c && !/^acceptance criteria:?$/i.test(l)) r.criteria.push(c);
      }
      r.criteria = r.criteria.filter(Boolean);
      r.text = [r.text].concat(r.criteria).map(x => x.replace(/[.\s]+$/, '')).join('. ').trim();
    }
  }

  // ------------------------------------------------------------------ boundaries
  const N = '\\$?(-?\\d+(?:\\.\\d+)?)';
  const UNIT = '(?:\\s*(characters?|chars?|letters?|digits?|numbers?|items?|products?|units?|records?|rows?|files?|attempts?|tries|times|years?|months?|weeks?|days?|hours?|minutes?|mins?|seconds?|secs?|ms|milliseconds?|%|percent|kb|mb|gb|words?|users?|people|guests?|tickets?|dollars?|aud|cents?|kg|g|km|m)\\b)?';
  const TIME_UNIT = /^(ms|milliseconds?|seconds?|secs?|minutes?|mins?)$/i;

  function decimals(a) { const s = String(a); const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; }
  function stepFor(...vals) { const d = Math.max(...vals.map(decimals)); return d ? Math.pow(10, -d) : 1; }
  const fix = (v, st) => (st < 1 ? +v.toFixed(decimals(st)) : v);
  function normUnit(u) {
    if (!u) return '';
    u = u.toLowerCase();
    if (/^chars?$|^characters?$|^letters?$/.test(u)) return 'characters';
    if (u === 'percent') return '%';
    return u;
  }
  function subjectBefore(text, idx, unit) {
    const before = text.slice(0, idx).split(/[.!?;:\n]\s/).pop().replace(/[,;:(]+\s*$/, '').trim();
    const words = before.split(/\s+/);
    const stop = /^(must|should|shall|can|cannot|can't|will|be|is|are|has|have|contain|contains|accept|accepts|allow|allows|only|of|a|an|the|length|value|between|from|to|with|and|or|not|no|up|at|it|its|that|which|must not|be)$/i;
    while (words.length && stop.test(words[words.length - 1])) words.pop();
    let subj = words.slice(-3).join(' ').replace(/^(the|a|an)\s+/i, '');
    subj = subj.replace(/^.*\b(?:must|should|shall|and|or|with|when|if|that)\s+/i, '');
    if (!subj) subj = 'value';
    if (unit === 'characters' && !/length/i.test(subj)) subj += ' length';
    else if (unit && unit !== '%' && !/count|number|age/i.test(subj) && /items?|products?|files?|attempts?|users?|tickets?|guests?|rows?|records?/.test(unit)) subj = 'number of ' + unit.replace(/s?$/, 's');
    return cap(subj);
  }

  function detectBoundaries(text) {
    let t = String(text || '');
    const out = [];
    const mask = (m) => { t = t.slice(0, m.index) + ' '.repeat(m[0].length) + t.slice(m.index + m[0].length); };
    const add = (b, m) => {
      b.unit = normUnit(b.unit);
      if (TIME_UNIT.test(b.unit) && /\b(within|respond|response|load|latency|under|in under|takes?|wait)\b/i.test(text)) { mask(m); return; }
      b.field = subjectBefore(t, m.index, b.unit);
      b.phrase = m[0].trim();
      out.push(b); mask(m);
    };
    const run = (re, fn) => { let m; re.lastIndex = 0; const found = []; while ((m = re.exec(t))) found.push(m); found.forEach(mm => fn(mm)); };

    run(new RegExp('\\b(?:between|from)\\s+' + N + UNIT + '\\s*(?:and|to|-|–)\\s*' + N + UNIT, 'gi'),
      m => add({ kind: 'range', min: +m[1], max: +m[3], unit: m[4] || m[2] || '' }, m));
    run(new RegExp(N + '\\s*(?:-|–|to)\\s*' + N + '\\s*(characters?|chars?|digits?|items?|years?|days?|letters?|words?|%|mb|kb)\\b', 'gi'),
      m => add({ kind: 'range', min: +m[1], max: +m[2], unit: m[3] }, m));
    run(new RegExp('\\bexactly\\s+' + N + UNIT, 'gi'), m => add({ kind: 'exact', value: +m[1], unit: m[2] || '' }, m));
    run(new RegExp('(?:\\bmax(?:imum)?(?:\\s+of)?|\\bat most|\\bup to|\\bno more than|\\bnot (?:exceed|be more than|be greater than|be longer than)|\\bcannot exceed|\\bmust not exceed|\\bless than or equal to|<=|≤)\\s*' + N + UNIT, 'gi'),
      m => add({ kind: 'max', value: +m[1], unit: m[2] || '' }, m));
    run(new RegExp(N + UNIT + '\\s*(?:max(?:imum)?|or (?:less|fewer|under|below|younger)|at most)\\b', 'gi'),
      m => add({ kind: 'max', value: +m[1], unit: m[2] || '' }, m));
    run(new RegExp('(?:\\bmin(?:imum)?(?:\\s+of)?|\\bat least|\\bno (?:less|fewer) than|\\bgreater than or equal to|>=|≥)\\s*' + N + UNIT, 'gi'),
      m => add({ kind: 'min', value: +m[1], unit: m[2] || '' }, m));
    run(new RegExp(N + UNIT + '\\s*(?:min(?:imum)?|or (?:more|over|above|older|greater))\\b', 'gi'),
      m => add({ kind: 'min', value: +m[1], unit: m[2] || '' }, m));
    run(new RegExp('(?:\\bless than|\\bfewer than|\\bunder|\\bbelow|<)\\s*' + N + UNIT, 'gi'),
      m => add({ kind: 'lt', value: +m[1], unit: m[2] || '' }, m));
    run(new RegExp('(?:\\bmore than|\\bgreater than|\\bover|\\babove|\\bexceeds?|\\bexceeding|>)\\s*' + N + UNIT, 'gi'),
      m => add({ kind: 'gt', value: +m[1], unit: m[2] || '' }, m));

    const seen = {};
    return out.filter(b => {
      b.values = boundaryValues(b);
      const k = b.field.toLowerCase() + '|' + b.values.map(v => v.value + (v.valid ? '+' : '-')).join(',');
      if (seen[k]) return false;
      seen[k] = 1; return true;
    });
  }

  function boundaryValues(b) {
    const countLike = b.unit && b.unit !== '%' && !/^(dollars?|aud|cents?|kg|g|km|m)$/.test(b.unit);
    const vals = [];
    const v = (value, valid, note) => {
      if (countLike && value < 0) return;
      if (!vals.some(x => x.value === value)) vals.push({ value, valid, note });
    };
    if (b.kind === 'range') {
      const s = stepFor(b.min, b.max);
      v(fix(b.min - s, s), false, 'just below the minimum'); v(b.min, true, 'the minimum'); v(fix(b.min + s, s), true, 'just above the minimum');
      v(fix(b.max - s, s), true, 'just below the maximum'); v(b.max, true, 'the maximum'); v(fix(b.max + s, s), false, 'just above the maximum');
    } else if (b.kind === 'max') {
      const s = stepFor(b.value); v(fix(b.value - s, s), true, 'just below the maximum'); v(b.value, true, 'the maximum'); v(fix(b.value + s, s), false, 'just above the maximum');
    } else if (b.kind === 'min') {
      const s = stepFor(b.value); v(fix(b.value - s, s), false, 'just below the minimum'); v(b.value, true, 'the minimum'); v(fix(b.value + s, s), true, 'just above the minimum');
    } else if (b.kind === 'lt') {
      const s = stepFor(b.value); v(fix(b.value - s, s), true, 'largest valid value'); v(b.value, false, 'the limit itself, outside the rule');
    } else if (b.kind === 'gt') {
      const s = stepFor(b.value); v(b.value, false, 'the limit itself, outside the rule'); v(fix(b.value + s, s), true, 'smallest valid value');
    } else if (b.kind === 'exact') {
      const s = stepFor(b.value); v(fix(b.value - s, s), false, 'one too few'); v(b.value, true, 'exact'); v(fix(b.value + s, s), false, 'one too many');
    }
    return vals;
  }

  function describeBoundary(b) {
    const u = b.unit && b.field.toLowerCase().indexOf(b.unit.replace(/s$/, '')) < 0 ? ' ' + b.unit : '';
    if (b.kind === 'range') return b.field + ' between ' + b.min + ' and ' + b.max + u;
    if (b.kind === 'max') return b.field + ' at most ' + b.value + u;
    if (b.kind === 'min') return b.field + ' at least ' + b.value + u;
    if (b.kind === 'lt') return b.field + ' less than ' + b.value + u;
    if (b.kind === 'gt') return b.field + ' more than ' + b.value + u;
    return b.field + ' exactly ' + b.value + u;
  }

  // ------------------------------------------------------------------ scenarios
  const KW = {
    login: /\b(log ?in|sign ?in|password|credential|authenticat|2fa|mfa|one-time code|otp)\b/i,
    email: /\b(?:enter|enters|input|provide|change|update|valid|invalid|format|register|sign up|signs up)\b[^.]{0,40}\be-?mail\b|\be-?mail (?:address|field)\b/i,
    payment: /\b(pay|payment|card|checkout|refund|invoice|bank|bsb|transfer|purchase)\b/i,
    upload: /\b(upload|attach|attachment|file|image|document|photo)\b/i,
    date: /\b(date|dob|birth|calendar|expiry|expire|schedule|booking)\b/i,
    search: /\b(search|filter|find|query|look up|lookup)\b/i,
    phone: /\b(phone|mobile|sms)\b/i,
    dup: /\b(duplicate|unique|already exists|already registered|only once)\b/i,
    session: /\b(session|time ?out|timeout|expired?|link|token|remember me)\b/i,
    neg: /\b(must not|shall not|should not|cannot|can't|not be able|not allowed|prevent|block|reject|deny|forbid)\b/i,
    roles: /\b(admin|administrator|manager|approver|owner|staff|supervisor|editor|viewer|role|permission|authori[sz]ed|only|privilege|guest|anonymous)s?\b/i,
    signedIn: /\b(user|account|customer|member|sign|log ?in|profile)\b/i,
    input: /\b(enter|enters|input|field|form|provide|submit|name|e-?mail|password|address|phone|value|text|comment|description|select|choose|type)\b/i,
    api: /\b(api|endpoint|request|payload|json|rest|graphql|response body|webhook)\b/i,
    perf: /\b(performance|fast|quick(?:ly)?|within \d|in under \d|response time|latency|loads?|loading|concurrent|simultaneous|peak|throughput|scal(?:e|able|ing)|\d+(?:\.\d+)?\s*(?:seconds?|secs?|ms)|at the same time|high volume|bulk)\b/i,
    sec: /\b(password|log ?in|sign ?in|auth\w*|token|session|payment|card|personal|pii|privacy|private|encrypt\w*|secure|security|role|permission|admin\w*|upload|tfn|medicare|bank|account|address|dob|birth|credential)\b/i,
    a11y: /\b(screen|page|form|button|ui|display|displays|show|shows|view|click|tap|accessib\w*|wcag|keyboard|screen reader|colou?r|contrast|mobile|link|menu|modal|dialog|message|banner|label|icon)\b/i,
  };

  function shortAction(r) {
    if (r.type === 'story' && r.want) return r.want.replace(/\.$/, '').replace(/\bmy\b/gi, 'their').replace(/\bmyself\b/gi, 'themselves').replace(/\bI\b/g, 'they').replace(/\bme\b/g, 'them');
    return clip(r.title.replace(/\.$/, ''), 90);
  }
  function perfTarget(text) {
    const m = /(?:within|in under|under|less than|below|in)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|seconds?|secs?|s)\b/i.exec(text);
    return m ? m[1] + ' ' + (/^ms|milli/i.test(m[2]) ? 'ms' : 'seconds') : '';
  }

  function generateScenarios(reqs, opts) {
    opts = opts || {};
    const all = [];
    (reqs || []).forEach(r => {
      const list = [];
      const text = String(r.text || r.title || '').trim();
      const role = r.role || ((/\b(admin|administrator|manager|approver|customer|member|staff|guest)\b/i.exec(text) || [])[1] || '');
      const action = shortAction(r);
      const add = (type, title, pre, steps, expected, priority, data) =>
        list.push({ type, title: clip(title, 140), pre: pre || '', steps: steps || '', expected: expected || '', priority: priority || 'Medium', data: data || '' });
      const preRole = role ? 'Signed in as ' + role.replace(/^(a|an|the)\s+/i, '') : (KW.signedIn.test(text) ? 'A signed-in user with access to the feature' : 'The system is available');
      const negatedReq = KW.neg.test(r.title);

      // Happy path
      if (r.type === 'gherkin' && r.steps) {
        add('Happy path', r.title, r.steps.given.join('; '), r.steps.when.join('\n') || 'Perform the action', r.steps.then.join('\n') || 'The expected outcome happens', 'High');
      } else if (r.type === 'story') {
        add('Happy path', cap(role || 'User') + ' can ' + action, preRole, 'Open the feature\n' + cap(action) + ' using valid data\nConfirm the result',
          r.benefit ? 'The action succeeds, so that ' + r.benefit.replace(/\.$/, '') : 'The action succeeds and the result is saved and shown', 'High');
      } else if (!negatedReq) {
        add('Happy path', 'Valid case: ' + action, preRole, 'Set up valid data\nPerform the action in the requirement: ' + action, 'The system behaves as the requirement states: ' + clip(r.title, 160), 'High');
      }
      if (negatedReq) {
        add('Negative', 'Blocked: ' + action, preRole, 'Attempt the action the requirement forbids', 'The action is blocked with a clear message, and nothing is changed or saved', 'High');
      }
      // Each acceptance criterion is its own check
      (r.criteria || []).forEach((c, i) => add('Acceptance', 'AC' + (i + 1) + ': ' + c, preRole, 'Set up the condition in the criterion\nPerform the action', cap(c), 'High'));

      // Negative cases by keyword
      const negs = [];
      if (KW.login.test(text)) negs.push(['Wrong password or code is rejected', 'Enter a valid username with a wrong password (or an expired code)', 'A generic error that does not say which field was wrong; the attempt is counted towards lock-out']);
      if (KW.email.test(text)) negs.push(['Badly formed email is rejected', 'Enter emails such as "name@", "name@@x.com", "name@x..com" and one with a trailing space', 'Each is rejected with a clear message; a valid email with + or a subdomain is accepted']);
      if (KW.payment.test(text)) negs.push(['Declined payment is handled', 'Pay with a declined test card, then an insufficient-funds test card', 'A clear message, no order or charge is created, and the user can try again']);
      if (KW.upload.test(text)) negs.push(['Wrong file type is rejected', 'Upload an unsupported type, a renamed file (.exe as .pdf) and an empty file', 'Rejected before processing with a message that lists the allowed types']);
      if (KW.date.test(text)) negs.push(['Invalid dates are rejected', 'Enter 31/02, 29/02 in a non-leap year, a far past and a far future date', 'Invalid dates are rejected; valid edge dates (29/02/2028) are accepted']);
      if (KW.search.test(text)) negs.push(['Search with no matches', 'Search for a term that matches nothing, then special characters such as % _ \' "', 'An empty state with a helpful message; special characters do not cause an error']);
      if (KW.phone.test(text)) negs.push(['Invalid phone number is rejected', 'Enter too few digits, letters and an international format', 'Invalid numbers are rejected; formats you support (04xx, +614xx) are accepted']);
      if (KW.dup.test(text)) negs.push(['Duplicate is rejected', 'Create the same record twice, including with different letter case and spaces', 'The second attempt is rejected and the first record is unchanged']);
      if (KW.session.test(text)) negs.push(['Expired session or link is rejected', 'Wait past the expiry (or change the clock in a test environment) and retry', 'The user is asked to start again; no data is changed']);
      if (!negs.length && !negatedReq) negs.push(['Invalid input is rejected', 'Perform the action with invalid or missing data', 'A clear error, nothing is saved, and the user can correct the input']);
      negs.forEach(n => add('Negative', n[0], preRole, n[1], n[2], KW.sec.test(text) ? 'High' : 'Medium'));

      // Boundaries and equivalence classes
      const bounds = detectBoundaries(text);
      bounds.forEach(b => {
        b.values.forEach(bv => add('Boundary', describeBoundary(b) + ': ' + bv.value + (b.unit ? ' ' + b.unit : '') + ' (' + bv.note + ')', preRole,
          'Set ' + b.field.toLowerCase() + ' to ' + bv.value + (b.unit ? ' ' + b.unit : '') + '\nSubmit', bv.valid ? 'Accepted' : 'Rejected with a clear message', 'Medium', String(bv.value)));
        const lo = b.kind === 'range' ? b.min : b.kind === 'min' || b.kind === 'gt' ? b.value : null;
        const hi = b.kind === 'range' ? b.max : b.kind === 'max' || b.kind === 'lt' ? b.value : null;
        const mid = lo != null && hi != null ? r1((lo + hi) / 2) : lo != null ? lo + stepFor(lo) * 5 : hi != null ? Math.max(0, hi - stepFor(hi) * 5) : b.value;
        add('Equivalence', 'Valid class: typical ' + b.field.toLowerCase() + ' (' + mid + (b.unit ? ' ' + b.unit : '') + ')', preRole, 'Use one typical value from the valid range', 'Accepted', 'Medium', String(mid));
        if (lo != null) add('Equivalence', 'Invalid class: ' + b.field.toLowerCase() + ' below the range', preRole, 'Use a value well below ' + lo, 'Rejected', 'Low');
        if (hi != null) add('Equivalence', 'Invalid class: ' + b.field.toLowerCase() + ' above the range', preRole, 'Use a value well above ' + hi, 'Rejected', 'Low');
        if (b.unit === 'characters') add('Equivalence', 'Special characters in ' + b.field.toLowerCase().replace(/ length$/, ''), preRole, 'Use accented letters, emoji, leading and trailing spaces and an apostrophe (O\'Brien)', 'Stored and shown correctly; length counts characters as the user sees them', 'Low');
        else add('Equivalence', 'Wrong type for ' + b.field.toLowerCase(), preRole, 'Enter letters, symbols and a decimal where a whole number is expected', 'Rejected with a clear message', 'Low');
      });

      // Permissions
      if (KW.roles.test(text) || r.role) {
        const rl = (role || 'the required role').replace(/^(a|an|the)\s+/i, '');
        add('Permissions', 'A user without the ' + rl + ' role cannot ' + action, 'Signed in as a user without the ' + rl + ' role', 'Try the action from the screen and by calling the URL or API directly', 'Access denied (403 or a clear message), nothing is changed, and the attempt is logged', 'High');
      }
      if (KW.signedIn.test(text)) add('Permissions', 'Signed-out user cannot ' + action, 'Not signed in', 'Open the page or call the API without a session', 'Redirected to sign in (or 401 for the API); no data is shown', 'Medium');

      // Empty and null
      if (KW.input.test(text)) {
        add('Empty/null', 'Required fields left empty', preRole, 'Leave each required field empty in turn and submit', 'A message beside each empty field; nothing is saved', 'Medium');
        add('Empty/null', 'Whitespace only', preRole, 'Enter only spaces in text fields and submit', 'Treated as empty and rejected', 'Low');
      }
      if (KW.api.test(text)) add('Empty/null', 'Null and missing fields in the request', 'API client with a valid token', 'Send the request with each required field set to null, then removed, then with an empty body', '400 with a message naming the field; no 500 errors', 'Medium');

      // Non-functional prompts (only when the words suggest them)
      if (KW.perf.test(text)) {
        const tgt = perfTarget(text);
        add('Performance', 'Response time under peak load', 'A production-like environment and expected peak traffic',
          'Run a load test at expected peak for the action\nRecord p95 and p99 response times and the error rate',
          tgt ? 'p95 within ' + tgt + ' at peak with under 1% errors' : 'p95 within the agreed target at peak (agree a number if none is written down)', 'Medium');
      }
      if (KW.sec.test(text)) {
        const sec = [];
        if (KW.login.test(text)) sec.push('passwords are never logged or shown, brute force is rate-limited, and sessions end on sign-out');
        if (KW.upload.test(text)) sec.push('uploaded files are scanned, size-limited and never run');
        if (KW.payment.test(text)) sec.push('card numbers are never stored or logged (PCI DSS)');
        if (KW.input.test(text)) sec.push('script and SQL in text fields are escaped, not run');
        if (KW.roles.test(text)) sec.push('one user cannot see or change another user\'s data by changing an id');
        if (!sec.length) sec.push('personal data is only shown to the right user and is not written to logs');
        add('Security', 'Security checks for ' + action, preRole, 'Check that ' + sec.join('; '), 'No data leaks and every check above holds', 'High');
      }
      if (KW.a11y.test(text) && !KW.api.test(r.title)) {
        add('Accessibility', 'Keyboard and screen reader use', preRole, 'Complete the task with the keyboard only, then with a screen reader (NVDA or VoiceOver)', 'Every control is reachable and labelled, focus is visible, errors are announced, contrast meets WCAG 2.2 AA', 'Medium');
      }

      list.forEach((s, i) => { s.id = r.id + '-TC' + pad(i + 1, 2); s.reqId = r.id; s.reqTitle = r.title; all.push(s); });
    });
    if (opts.types) return all.filter(s => opts.types.indexOf(s.type) >= 0);
    return all;
  }

  const TYPES = ['Happy path', 'Acceptance', 'Negative', 'Boundary', 'Equivalence', 'Permissions', 'Empty/null', 'Performance', 'Security', 'Accessibility'];

  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? '"' + (/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""') + '"' : s;
  }
  function toCSV(rows) { return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n'; }

  // Columns map cleanly onto Zephyr Scale and Xray CSV import (Name / Objective / Precondition / Step / Data / Expected).
  function scenariosToCSV(list) {
    const rows = [['Test ID', 'Name', 'Requirement', 'Test Type', 'Priority', 'Labels', 'Precondition', 'Action', 'Data', 'Expected Result']];
    (list || []).forEach(s => rows.push([s.id, s.title, s.reqId, s.type, s.priority, 'qa-copilot ' + s.type.toLowerCase().replace(/[^a-z]+/g, '-'), s.pre, s.steps, s.data || '', s.expected]));
    return toCSV(rows);
  }

  function scenariosToGherkin(list, reqs) {
    const byReq = {};
    const order = [];
    (list || []).forEach(s => { if (!byReq[s.reqId]) { byReq[s.reqId] = []; order.push(s.reqId); } byReq[s.reqId].push(s); });
    const titleOf = id => { const r = (reqs || []).find(x => x.id === id); return r ? r.title : (byReq[id][0].reqTitle || id); };
    const tag = t => '@' + t.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const lines = [];
    const steps = (kw, text) => String(text || '').split('\n').map(x => x.trim()).filter(Boolean).map((x, i) => '    ' + (i ? 'And ' : kw + ' ') + lowerFirst(x.replace(/^(given|when|then|and)\s+/i, '')));
    const lowerFirst = x => (/^[A-Z][a-z]/.test(x) ? x.charAt(0).toLowerCase() + x.slice(1) : x);
    order.forEach(id => {
      lines.push('@' + id.replace(/\s+/g, '-'));
      lines.push('Feature: ' + clip(titleOf(id), 120));
      const items = byReq[id];
      const bound = items.filter(s => s.type === 'Boundary');
      items.filter(s => s.type !== 'Boundary').forEach(s => {
        lines.push('', '  ' + tag(s.type) + ' ' + tag(s.priority));
        lines.push('  Scenario: ' + s.title);
        lines.push(...steps('Given', s.pre || 'the system is available'));
        lines.push(...steps('When', s.steps || 'the action is performed'));
        lines.push(...steps('Then', s.expected || 'the expected result happens'));
      });
      if (bound.length) {
        lines.push('', '  @boundary', '  Scenario Outline: Boundary values', '    Given ' + lowerFirst((bound[0].pre || 'the system is available').replace(/^(given)\s+/i, '')),
          '    When the value is set to <value>', '    Then the result is <result>', '', '    Examples:', '      | value | result | note |');
        bound.forEach(s => {
          const note = (/\(([^)]*)\)\s*$/.exec(s.title) || [])[1] || '';
          lines.push('      | ' + (s.data || '') + ' | ' + (/^accepted/i.test(s.expected) ? 'accepted' : 'rejected') + ' | ' + note.replace(/\|/g, '/') + ' |');
        });
      }
      lines.push('', '');
    });
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  // ------------------------------------------------------------------ strategy
  const LEVEL_TEXT = {
    unit: ['Unit', 'Developers write and run unit tests on every commit. Target meaningful coverage of business rules rather than a raw percentage.'],
    integration: ['Integration', 'Check that services, databases and queues work together, using real dependencies or contract tests where real ones are not available.'],
    api: ['API', 'Automated tests for every endpoint: valid requests, validation errors, authorisation and contract (schema) checks. These carry most of the functional regression.'],
    ui: ['UI / end-to-end', 'A small set of automated journeys through the real user interface for the flows that earn money or carry the most risk. Keep it small so it stays stable.'],
    exploratory: ['Exploratory', 'Time-boxed, charter-based sessions on new and changed features to find what scripted tests miss.'],
    performance: ['Performance', 'Load tests at expected peak and stress tests beyond it before major releases, with agreed response time and error rate targets.'],
    security: ['Security', 'Dependency and container scanning in the pipeline, OWASP Top 10 checks on new endpoints, and a penetration test before go-live for high-risk changes.'],
    accessibility: ['Accessibility', 'Automated checks (axe) in the pipeline plus manual keyboard and screen reader checks against WCAG 2.2 AA for new screens.'],
    uat: ['User acceptance', 'Business users confirm the release meets their needs, using real-world scenarios. QA prepares the environment, data and scripts.'],
    regression: ['Regression', 'An automated regression suite runs on every merge, with a fuller run on each release candidate.'],
  };
  const PROJECT_TEXT = {
    web: 'a web application', mobile: 'a mobile app (iOS and Android)', api: 'APIs and microservices', data: 'a data platform (ETL, reporting and analytics)',
    package: 'a configured enterprise package (such as Salesforce, SAP or Dynamics)', migration: 'a migration or upgrade', ai: 'an AI or LLM-based product',
  };
  const RISK = {
    low: { exitPass: 90, exitCrit: 0, exitHigh: 3, label: 'Low' },
    medium: { exitPass: 95, exitCrit: 0, exitHigh: 1, label: 'Medium' },
    high: { exitPass: 98, exitCrit: 0, exitHigh: 0, label: 'High' },
    critical: { exitPass: 100, exitCrit: 0, exitHigh: 0, label: 'Critical / regulated' },
  };

  function buildStrategy(f) {
    f = f || {};
    const name = (f.project || 'the project').trim();
    const risk = RISK[f.risk] || RISK.medium;
    const levels = (f.levels && f.levels.length ? f.levels : ['unit', 'api', 'ui', 'regression']).filter(l => LEVEL_TEXT[l]);
    const envs = (f.environments && f.environments.length ? f.environments : ['Dev', 'Test', 'Staging', 'Production']);
    const team = Math.max(1, Math.round(num(f.teamSize, 3)));
    const cadence = f.cadence || 'fortnightly';
    const fast = /daily|weekly|continuous/.test(cadence);
    const L = [];
    L.push('# Test strategy: ' + name, '');
    if (f.version || f.author) L.push('**Version:** ' + (f.version || '0.1') + (f.author ? ' · **Owner:** ' + f.author : '') + ' · **Date:** ' + (f.date || ''), '');
    L.push('## 1. Purpose and scope', '');
    L.push('This strategy describes how ' + name + ', ' + (PROJECT_TEXT[f.type] || 'a software product') + ', will be tested: what we test, how deep, in which environments, and when it is ready to release. Risk level: **' + risk.label + '**. Releases: **' + cadence + '**.', '');
    const list = s => String(s || '').split(/\n|;|,(?![^(]*\))/).map(x => x.trim()).filter(Boolean);
    const ins = list(f.inScope), outs = list(f.outScope);
    L.push('**In scope**', '');
    (ins.length ? ins : ['All new and changed features in each release', 'Regression of existing critical journeys']).forEach(x => L.push('- ' + x));
    L.push('', '**Out of scope**', '');
    (outs.length ? outs : ['Third-party systems beyond their interfaces', 'Hardware and network infrastructure testing']).forEach(x => L.push('- ' + x));
    L.push('', '## 2. Test levels and approach', '');
    L.push('| Level | Approach |', '|---|---|');
    levels.forEach(l => L.push('| ' + LEVEL_TEXT[l][0] + ' | ' + LEVEL_TEXT[l][1] + ' |'));
    L.push('');
    if (f.type === 'mobile') L.push('Test on a device matrix covering the top devices and OS versions from analytics (at least the latest two major versions of each OS).', '');
    if (f.type === 'data') L.push('Reconcile record counts and totals between source and target for every load, and check data quality rules (nulls, duplicates, referential integrity).', '');
    if (f.type === 'package') L.push('Focus on configuration, integrations and business processes; do not retest the vendor\'s core features.', '');
    if (f.type === 'migration') L.push('Reconcile migrated data, run parallel comparisons where possible, and rehearse the cut-over and the rollback.', '');
    if (f.type === 'ai') L.push('Use evaluation sets with expected answers, check for harmful or made-up output, and test cost and latency under load.', '');
    L.push('## 3. Risk-based prioritisation', '');
    L.push('Each feature is rated for business impact and likelihood of failure. High-impact, high-likelihood areas get the deepest testing and are automated first. ' +
      (f.risk === 'critical' || f.risk === 'high' ? 'Because the overall risk is ' + risk.label.toLowerCase() + ', every change to a critical journey needs peer-reviewed test cases and traceability from requirement to test result.' : 'Lower-risk areas get lighter, exploratory coverage.'), '');
    L.push('## 4. Environments and test data', '');
    L.push('| Environment | Purpose |', '|---|---|');
    envs.forEach(e => {
      const k = e.toLowerCase();
      const p = /dev/.test(k) ? 'Developer testing, unit and component tests' : /prod/.test(k) ? 'Smoke tests and monitoring after release only' : /stag|pre|uat/.test(k) ? 'Release candidate testing, UAT and performance tests in a production-like setup' : /perf|load/.test(k) ? 'Performance and load testing at production scale' : 'Functional, API and regression testing';
      L.push('| ' + e + ' | ' + p + ' |');
    });
    L.push('', 'Test data is synthetic or masked; production personal data is never copied to test environments. Data is created by scripts so tests can be repeated.', '');
    L.push('## 5. Entry and exit criteria', '');
    L.push('**Entry:** build deployed to the test environment, smoke tests pass, stories have acceptance criteria, test data is ready.', '');
    L.push('**Exit:**', '');
    L.push('- At least ' + risk.exitPass + '% of planned tests executed and passed');
    L.push('- No open critical defects' + (risk.exitHigh ? ', and no more than ' + risk.exitHigh + ' open high defects with an agreed workaround' : ', and no open high defects'));
    L.push('- Every in-scope requirement has at least one passing test');
    if (levels.indexOf('performance') >= 0) L.push('- Performance targets met at expected peak load');
    if (levels.indexOf('security') >= 0) L.push('- No unresolved critical or high security findings');
    L.push('');
    L.push('## 6. Automation approach', '');
    L.push('Follow the test pyramid: most checks at unit and API level, a thin layer of UI journeys. ' + (fast ? 'With ' + cadence + ' releases, automated regression in the CI/CD pipeline is essential: every merge runs the fast suite and blocks on failure.' : 'Automated regression runs nightly and on each release candidate; manual testing focuses on new features.') +
      ' Flaky tests are quarantined within a day and fixed or deleted within a sprint.', '');
    L.push('## 7. Defect management', '');
    L.push('| Severity | Meaning | Target fix time |', '|---|---|---|');
    const sl = f.risk === 'critical' || f.risk === 'high' ? ['4 hours', '1 business day', 'Next sprint', 'Backlog'] : ['1 business day', '3 business days', 'Next sprint', 'Backlog'];
    L.push('| Critical | System down, data loss or security breach; no workaround | ' + sl[0] + ' |');
    L.push('| High | Major feature broken; workaround is hard | ' + sl[1] + ' |');
    L.push('| Medium | Feature partly broken; workaround exists | ' + sl[2] + ' |');
    L.push('| Low | Cosmetic or minor issue | ' + sl[3] + ' |', '');
    L.push('Every defect has steps to reproduce, expected and actual results, environment and evidence. Fixed defects are retested and the area around them is regression tested.', '');
    L.push('## 8. Roles and responsibilities', '');
    if (team <= 2) L.push('With a team of ' + team + ', testers pair with developers on automation and own the strategy, exploratory testing and release sign-off recommendation.', '');
    else L.push('- **QA lead:** owns this strategy, planning, reporting and the release recommendation', '- **Testers / SDETs (' + Math.max(1, team - 1) + '):** test design, automation, execution and defect management', '- **Developers:** unit and integration tests, fixing defects, reviewing test coverage', '- **Product owner:** acceptance criteria, priorities and UAT sign-off', '');
    L.push('## 9. Tools', '');
    const tools = list(f.tools);
    (tools.length ? tools : ['Test management: Jira with Zephyr Scale or Xray', 'API and UI automation: Playwright', 'Performance: k6 or JMeter', 'CI/CD: GitHub Actions, GitLab CI or Jenkins']).forEach(t => L.push('- ' + t));
    L.push('', '## 10. Reporting and metrics', '');
    L.push('- Requirement coverage and test execution progress (' + (fast ? 'live dashboard' : 'weekly report') + ')', '- Open defects by severity and age', '- Automation pass rate and flaky test rate', '- Escaped defects found in production after each release', '');
    L.push('## 11. Risks and mitigations', '');
    L.push('| Risk | Mitigation |', '|---|---|');
    L.push('| Test environment unavailable or unstable | Book environments early; health checks before each test cycle |');
    L.push('| Late changes to requirements | Testers review stories at refinement; re-estimate when scope changes |');
    if (fast) L.push('| Fast release cadence leaves no time for manual regression | Automate critical journeys first; release behind feature flags |');
    if (team <= 2) L.push('| Small team: one person away stops testing | Document test approach; developers share regression duties |');
    L.push('| Unrealistic test data hides defects | Script data creation from production-like profiles |', '');
    L.push('## 12. Approval', '');
    L.push('| Role | Name | Date |', '|---|---|---|', '| QA lead | | |', '| Product owner | | |', '| Delivery / engineering manager | | |', '');
    return L.join('\n');
  }

  // ------------------------------------------------------------------ estimation
  const EST_DEFAULTS = {
    simple: 20, medium: 15, complex: 5,
    designMins: { simple: 15, medium: 30, complex: 60 },
    execMins: { simple: 10, medium: 20, complex: 45 },
    cycles: 2, failPct: 15, retestPct: 100, automationPct: 30,
    autoHours: { simple: 1, medium: 2.5, complex: 5 },
    envHours: 16, regressionCycles: 1, regressionPct: 40, mgmtPct: 15, hoursPerDay: 7.6, uncertainty: 'medium',
  };
  const SPREAD = { low: [0.85, 1.3], medium: [0.8, 1.6], high: [0.7, 2.0] };

  function estimate(inp) {
    const i = Object.assign({}, EST_DEFAULTS, inp || {});
    i.designMins = Object.assign({}, EST_DEFAULTS.designMins, (inp || {}).designMins);
    i.execMins = Object.assign({}, EST_DEFAULTS.execMins, (inp || {}).execMins);
    i.autoHours = Object.assign({}, EST_DEFAULTS.autoHours, (inp || {}).autoHours);
    const c = { simple: Math.max(0, num(i.simple)), medium: Math.max(0, num(i.medium)), complex: Math.max(0, num(i.complex)) };
    const total = c.simple + c.medium + c.complex;
    const sum = (m) => (c.simple * num(m.simple) + c.medium * num(m.medium) + c.complex * num(m.complex));
    const auto = Math.min(100, Math.max(0, num(i.automationPct))) / 100;
    const cycles = Math.max(0, num(i.cycles));
    const design = sum(i.designMins) / 60;
    const execOne = sum(i.execMins) / 60;
    const manualExec = execOne * (1 - auto) * cycles;
    const autoBuild = sum(i.autoHours) * auto;
    const autoRun = execOne * auto * cycles * 0.1; // reviewing results and fixing broken scripts
    const failures = total * cycles * num(i.failPct) / 100;
    const retest = failures * (num(i.retestPct) / 100) * (execOne / Math.max(1, total)) + failures * 0.25; // rerun + 15 min to log each defect
    const regression = execOne * (num(i.regressionPct) / 100) * (1 - auto) * Math.max(0, num(i.regressionCycles)) + execOne * (num(i.regressionPct) / 100) * auto * 0.1 * Math.max(0, num(i.regressionCycles));
    const env = Math.max(0, num(i.envHours));
    const base = design + manualExec + autoBuild + autoRun + retest + regression + env;
    const mgmt = base * num(i.mgmtPct) / 100;
    const rows = [
      { task: 'Test design and review', hours: design },
      { task: 'Environment and test data setup', hours: env },
      { task: 'Manual execution (' + cycles + ' cycle' + (cycles === 1 ? '' : 's') + ')', hours: manualExec },
      { task: 'Automation build (' + Math.round(auto * 100) + '% of tests)', hours: autoBuild },
      { task: 'Automated runs: review and maintenance', hours: autoRun },
      { task: 'Defect logging and retest', hours: retest },
      { task: 'Regression', hours: regression },
      { task: 'Test management and reporting (' + num(i.mgmtPct) + '%)', hours: mgmt },
    ].map(r => ({ task: r.task, hours: r1(r.hours) }));
    const M = base + mgmt;
    const sp = SPREAD[i.uncertainty] || SPREAD.medium;
    const O = M * sp[0], P = M * sp[1];
    const E = (O + 4 * M + P) / 6, SD = (P - O) / 6;
    const hpd = Math.max(1, num(i.hoursPerDay, 7.6));
    const days = h => r1(h / hpd);
    return {
      scenarios: total, rows,
      optimistic: r1(O), mostLikely: r1(M), pessimistic: r1(P), expected: r1(E), sd: r1(SD),
      p84: r1(E + SD), p95: r1(E + 1.645 * SD), contingency: r1(E + 1.645 * SD - M),
      contingencyPct: M ? Math.round((E + 1.645 * SD - M) / M * 100) : 0,
      days: { optimistic: days(O), mostLikely: days(M), pessimistic: days(P), expected: days(E), p84: days(E + SD), p95: days(E + 1.645 * SD) },
      hoursPerDay: hpd, uncertainty: i.uncertainty,
    };
  }

  // ------------------------------------------------------------------ coverage tracker
  const STATUSES = ['not run', 'pass', 'fail', 'blocked'];
  function normaliseStatus(s) {
    const t = String(s || '').trim().toLowerCase();
    if (/^(pass|passed|ok|success|successful|green|done|✓|✔)$/.test(t)) return 'pass';
    if (/^(fail|failed|failure|error|errored|broken|red|✗|✘)$/.test(t)) return 'fail';
    if (/^(blocked|block|impeded|on hold)$/.test(t)) return 'blocked';
    return 'not run';
  }
  const splitIds = s => String(s || '').split(/[,;|\s]+/).map(x => x.trim()).filter(Boolean);

  function coverage(model) {
    const reqs = (model && model.reqs) || [];
    const tests = (model && model.tests) || [];
    const byReq = {};
    reqs.forEach(r => { byReq[r.id.toUpperCase()] = []; });
    tests.forEach(t => (t.reqs || []).forEach(id => { const k = String(id).toUpperCase(); if (byReq[k]) byReq[k].push(t); }));
    const rows = reqs.map(r => {
      const ts = byReq[r.id.toUpperCase()];
      let status = 'uncovered';
      if (ts.length) {
        const st = ts.map(t => normaliseStatus(t.status));
        status = st.indexOf('fail') >= 0 ? 'fail' : st.indexOf('blocked') >= 0 ? 'blocked' : st.every(s => s === 'pass') ? 'pass' : st.every(s => s === 'not run') ? 'not run' : 'in progress';
      }
      return { id: r.id, title: r.title || '', tests: ts.map(t => t.id), status };
    });
    const count = s => rows.filter(r => r.status === s).length;
    const tStat = s => tests.filter(t => normaliseStatus(t.status) === s).length;
    const executed = tests.length - tStat('not run');
    const covered = rows.filter(r => r.status !== 'uncovered').length;
    return {
      rows,
      reqTotal: rows.length, covered, coveragePct: rows.length ? r1(covered / rows.length * 100) : 0,
      reqPass: count('pass'), reqFail: count('fail'), reqBlocked: count('blocked'), reqNotRun: count('not run'), reqInProgress: count('in progress'),
      uncovered: rows.filter(r => r.status === 'uncovered').map(r => r.id),
      testTotal: tests.length, executed, executedPct: tests.length ? r1(executed / tests.length * 100) : 0,
      pass: tStat('pass'), fail: tStat('fail'), blocked: tStat('blocked'), notRun: tStat('not run'),
      passPct: executed ? r1(tStat('pass') / executed * 100) : 0,
      orphanTests: tests.filter(t => !(t.reqs || []).some(id => byReq[String(id).toUpperCase()])).map(t => t.id),
    };
  }

  function parseCSV(text) {
    const s = String(text || '').replace(/^﻿/, '');
    const firstLine = s.split(/\r?\n/)[0] || '';
    const delim = [',', ';', '\t'].map(d => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) {
        if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
      } else if (ch === '"' && cell === '') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && s[i + 1] === '\n') i++;
        row.push(cell); cell = ''; if (row.some(c => c.trim() !== '')) rows.push(row); row = [];
      } else cell += ch;
    }
    row.push(cell); if (row.some(c => c.trim() !== '')) rows.push(row);
    return rows;
  }

  function importResults(model, csvText) {
    const m = JSON.parse(JSON.stringify(model || { reqs: [], tests: [] }));
    m.reqs = m.reqs || []; m.tests = m.tests || [];
    const rows = parseCSV(csvText);
    if (rows.length < 2) return { model: m, updated: 0, added: 0, skipped: 0, error: 'The CSV needs a header row and at least one result row.' };
    const head = rows[0].map(h => h.trim().toLowerCase());
    const find = re => head.findIndex(h => re.test(h));
    const iId = find(/^(test ?(case)? ?(id|key)|key|id|issue key|test|tc ?id|case id)$/);
    const iStatus = find(/status|result|outcome|execution|verdict/);
    const iTitle = find(/^(name|summary|title|test ?(case)? ?name|description)$/);
    const iReq = find(/requirement|^req|story|covers|linked|issue links|traceab/);
    if (iStatus < 0 || (iId < 0 && iTitle < 0)) return { model: m, updated: 0, added: 0, skipped: rows.length - 1, error: 'Could not find the columns. Use a header row with Test ID (or Name) and Status, and optionally Requirement.' };
    let updated = 0, added = 0, skipped = 0;
    rows.slice(1).forEach(r => {
      const id = iId >= 0 ? (r[iId] || '').trim() : '';
      const title = iTitle >= 0 ? (r[iTitle] || '').trim() : '';
      if (!id && !title) { skipped++; return; }
      let t = m.tests.find(x => (id && x.id.toLowerCase() === id.toLowerCase()) || (!id && title && (x.title || '').toLowerCase() === title.toLowerCase()));
      if (!t) { t = { id: id || 'TC-' + pad(m.tests.length + 1, 3), title: title || id, reqs: [], status: 'not run' }; m.tests.push(t); added++; } else updated++;
      t.status = normaliseStatus(r[iStatus]);
      if (title && !t.title) t.title = title;
      if (iReq >= 0) splitIds(r[iReq]).forEach(rid => {
        if (!t.reqs.some(x => x.toLowerCase() === rid.toLowerCase())) t.reqs.push(rid);
        if (!m.reqs.some(x => x.id.toLowerCase() === rid.toLowerCase())) m.reqs.push({ id: rid, title: '' });
      });
    });
    return { model: m, updated, added, skipped };
  }

  function coverageToCSV(model) {
    const rows = [['Test ID', 'Name', 'Requirement', 'Status']];
    (model.tests || []).forEach(t => rows.push([t.id, t.title || '', (t.reqs || []).join(' '), normaliseStatus(t.status)]));
    return toCSV(rows);
  }

  // ------------------------------------------------------------------ release risk
  const CHECKLIST = [
    { id: 'regression', label: 'Full regression run on the release candidate', weight: 10 },
    { id: 'uat', label: 'UAT signed off by the business', weight: 8 },
    { id: 'perf', label: 'Performance test passed at expected peak', weight: 8 },
    { id: 'security', label: 'Security scan with no open critical or high findings', weight: 8 },
    { id: 'rollback', label: 'Rollback plan written and rehearsed', weight: 8 },
    { id: 'monitoring', label: 'Monitoring and alerts ready for the new features', weight: 6 },
    { id: 'migration', label: 'Database migration rehearsed on production-like data', weight: 6 },
    { id: 'flags', label: 'Risky changes behind feature flags', weight: 4 },
    { id: 'smoke', label: 'Production smoke tests ready to run after deploy', weight: 4 },
    { id: 'support', label: 'Release notes shared and support team briefed', weight: 3 },
  ];

  function riskScore(inp) {
    inp = inp || {};
    const done = inp.checklist || {};
    const reasons = [];
    const blockers = [];
    // checklist: items set to 'na' are left out of the total
    let missW = 0, totW = 0;
    CHECKLIST.forEach(c => {
      const v = done[c.id];
      if (v === 'na') return;
      totW += c.weight;
      if (!(v === true || v === 'yes')) { missW += c.weight; reasons.push({ points: 0, text: 'Not done: ' + c.label.charAt(0).toLowerCase() + c.label.slice(1), w: c.weight }); }
    });
    const checkPts = totW ? missW / totW * 35 : 0;
    const share = totW ? 35 / totW : 0;
    reasons.forEach(r => { r.points = r1(r.w * share); delete r.w; });
    const d = { critical: Math.max(0, num(inp.critical)), high: Math.max(0, num(inp.high)), medium: Math.max(0, num(inp.medium)), low: Math.max(0, num(inp.low)) };
    const defPts = Math.min(30, d.critical * 25 + d.high * 6 + d.medium * 1.5 + d.low * 0.3);
    if (d.critical) { blockers.push(d.critical + ' open critical defect' + (d.critical > 1 ? 's' : '')); }
    if (d.critical || d.high || d.medium || d.low) reasons.push({ points: r1(defPts), text: 'Open defects: ' + ['critical', 'high', 'medium', 'low'].filter(k => d[k]).map(k => d[k] + ' ' + k).join(', ') });
    const cov = inp.coverage == null || inp.coverage === '' ? null : Math.min(100, Math.max(0, num(inp.coverage)));
    const pass = inp.passRate == null || inp.passRate === '' ? null : Math.min(100, Math.max(0, num(inp.passRate)));
    const covPts = cov == null ? 8 : Math.min(15, (100 - cov) * 0.3);
    const passPts = pass == null ? 5 : Math.min(10, (100 - pass) * 0.5);
    if (cov == null) reasons.push({ points: covPts, text: 'Requirement coverage is unknown' });
    else if (cov < 100) reasons.push({ points: r1(covPts), text: 'Requirement coverage is ' + cov + '% (' + r1(100 - cov) + '% of requirements have no test)' });
    if (cov != null && cov < 60) blockers.push('requirement coverage below 60%');
    if (pass == null) reasons.push({ points: passPts, text: 'Test pass rate is unknown' });
    else if (pass < 100) reasons.push({ points: r1(passPts), text: 'Test pass rate is ' + pass + '%' });
    if (pass != null && pass < 85) blockers.push('pass rate below 85%');
    const flaky = Math.max(0, num(inp.flakyRate));
    const flakyPts = Math.min(10, flaky * 1);
    if (flaky) reasons.push({ points: r1(flakyPts), text: flaky + '% of automated tests are flaky, so passing runs are less trustworthy' });
    const size = inp.changeSize || 'medium';
    const sizePts = size === 'large' ? 5 : size === 'small' ? 0 : 2;
    if (sizePts) reasons.push({ points: sizePts, text: (size === 'large' ? 'Large' : 'Medium-sized') + ' release: more change means more to go wrong' });
    const score = Math.round(Math.min(100, checkPts + defPts + covPts + passPts + flakyPts + sizePts));
    const level = score < 20 ? 'Low' : score < 40 ? 'Medium' : score < 60 ? 'High' : 'Very high';
    let decision, advice;
    if (blockers.length || score >= 60) { decision = 'No-go'; advice = blockers.length ? 'Do not release until these are resolved: ' + blockers.join('; ') + '.' : 'The combined risk is too high. Fix the top reasons below, then score again.'; }
    else if (score >= 30) { decision = 'Go with conditions'; advice = 'Release only with the top reasons below accepted in writing by the product owner, a tested rollback and someone watching the monitoring after deploy.'; }
    else { decision = 'Go'; advice = 'Risk is low. Release as planned and run the production smoke tests straight after deploy.'; }
    reasons.sort((a, b) => b.points - a.points);
    return { score, level, decision, advice, blockers, reasons, parts: { checklist: r1(checkPts), defects: r1(defPts), coverage: r1(covPts), passRate: r1(passPts), flaky: r1(flakyPts), size: sizePts } };
  }

  // ------------------------------------------------------------------ stakeholder report
  function buildReport(p) {
    p = p || {};
    const L = [];
    L.push('# ' + (p.project || 'Release') + ' test summary' + (p.release ? ': ' + p.release : ''), '');
    L.push('**Date:** ' + (p.date || '') + (p.author ? ' · **Prepared by:** ' + p.author : ''), '');
    if (p.risk) {
      L.push('## Recommendation: ' + p.risk.decision, '');
      L.push('Release risk score **' + p.risk.score + '/100 (' + p.risk.level + ')**. ' + p.risk.advice, '');
      if (p.risk.reasons.length) { L.push('**Top risks**', ''); p.risk.reasons.slice(0, 5).forEach(r => L.push('- ' + r.text)); L.push(''); }
    }
    if (p.coverage) {
      const c = p.coverage;
      L.push('## Test progress', '');
      L.push('| Measure | Value |', '|---|---|');
      L.push('| Requirements covered | ' + c.covered + ' of ' + c.reqTotal + ' (' + c.coveragePct + '%) |');
      L.push('| Tests executed | ' + c.executed + ' of ' + c.testTotal + ' (' + c.executedPct + '%) |');
      L.push('| Pass rate of executed tests | ' + c.passPct + '% |');
      L.push('| Passed / failed / blocked / not run | ' + c.pass + ' / ' + c.fail + ' / ' + c.blocked + ' / ' + c.notRun + ' |');
      L.push('');
      if (c.uncovered.length) L.push('**Requirements with no test:** ' + c.uncovered.slice(0, 20).join(', ') + (c.uncovered.length > 20 ? ' and ' + (c.uncovered.length - 20) + ' more' : ''), '');
      const failing = c.rows.filter(r => r.status === 'fail' || r.status === 'blocked');
      if (failing.length) L.push('**Requirements failing or blocked:** ' + failing.slice(0, 20).map(r => r.id + ' (' + r.status + ')').join(', '), '');
    }
    if (p.defects) {
      const d = p.defects;
      L.push('## Open defects', '', '| Critical | High | Medium | Low |', '|---|---|---|---|', '| ' + (d.critical || 0) + ' | ' + (d.high || 0) + ' | ' + (d.medium || 0) + ' | ' + (d.low || 0) + ' |', '');
    }
    if (p.estimate) {
      const e = p.estimate;
      L.push('## Effort', '');
      L.push('Expected effort **' + e.expected + ' hours (' + e.days.expected + ' days)**; plan for **' + e.p95 + ' hours (' + e.days.p95 + ' days)** to be 95% confident. Range ' + e.optimistic + ' to ' + e.pessimistic + ' hours.', '');
    }
    if (p.notes) L.push('## Notes', '', String(p.notes).trim(), '');
    return L.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  // ------------------------------------------------------------------ markdown → HTML (for the Markdown this file writes)
  function inline(s) {
    return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>');
  }
  function markdownToHtml(md) {
    const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      const h = /^(#{1,4})\s+(.*)$/.exec(l);
      if (h) { out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); i++; continue; }
      if (/^\s*\|/.test(l)) {
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
        const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        const hasHead = rows.length > 1 && /^\s*\|?\s*:?-{2,}/.test(rows[1]);
        let html = '<div class="tbl-wrap"><table class="data md">';
        if (hasHead) { html += '<thead><tr>' + cells(rows[0]).map(c => '<th>' + inline(c) + '</th>').join('') + '</tr></thead>'; rows.splice(0, 2); }
        html += '<tbody>' + rows.map(r => '<tr>' + cells(r).map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
        out.push(html); continue;
      }
      if (/^\s*[-*]\s+/.test(l)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
        out.push('<ul>' + items.map(x => '<li>' + inline(x) + '</li>').join('') + '</ul>'); continue;
      }
      if (/^\s*\d+[.)]\s+/.test(l)) {
        const items = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
        out.push('<ol>' + items.map(x => '<li>' + inline(x) + '</li>').join('') + '</ol>'); continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*\||\s*[-*]\s+|\s*\d+[.)]\s+)/.test(lines[i])) para.push(lines[i++]);
      out.push('<p>' + inline(para.join(' ')) + '</p>');
    }
    return out.join('\n');
  }

  const api = {
    parseRequirements, parseStory, detectBoundaries, boundaryValues, describeBoundary, generateScenarios, scenariosToCSV, scenariosToGherkin, TYPES,
    buildStrategy, LEVEL_TEXT, estimate, EST_DEFAULTS, coverage, normaliseStatus, parseCSV, importResults, coverageToCSV, STATUSES,
    riskScore, CHECKLIST, buildReport, markdownToHtml, toCSV, esc,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QACopilot = api;
})(typeof self !== 'undefined' ? self : this);
