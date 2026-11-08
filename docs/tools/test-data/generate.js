/* Test data generator: pure functions, no DOM, no external libraries.
   Runs in the browser (window.TestData), in a Web Worker (same file, message API at the bottom)
   and in Node (module.exports) for unit tests.

   A spec is:
     { rows: 1..100000, seed: 'any text', columns: [{ name, type, unique?, perOrder?, ...options }] }
   generate(spec) returns { columns, rows } where each row is an object keyed by column name.
   The same spec and seed always give the same rows.

   Safety rules built in:
   - Emails use the reserved example.com / example.net / example.org domains, so nothing reaches a real inbox.
   - Card numbers are either well-known public test numbers or Luhn-valid numbers on test BINs.
   - TFN and Medicare numbers are deliberately invalid: they always fail the official checksum.
*/
(function (root) {
  'use strict';

  const MAX_ROWS = 100000;

  // ---------------------------------------------------------------- seeded random

  // cyrb128 string hash -> sfc32 generator. Fast, small and well distributed.
  function hashSeed(str) {
    let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    str = String(str);
    for (let i = 0; i < str.length; i++) {
      const k = str.charCodeAt(i);
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
  }

  function makeRng(seed) {
    let [a, b, c, d] = hashSeed(seed);
    function next() {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      let t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    }
    for (let i = 0; i < 15; i++) next();
    const r = {
      next,
      // float in [0,1) with 53 bits, for very large ranges
      next53: () => (Math.floor(next() * 2097152) * 4294967296 + Math.floor(next() * 4294967296)) / 9007199254740992,
      int: n => (n > 4294967296 ? Math.floor(r.next53() * n) : Math.floor(next() * n)),
      range: (lo, hi) => lo + r.int(hi - lo + 1),
      pick: arr => arr[Math.floor(next() * arr.length)],
      chance: pct => next() * 100 < pct,
    };
    return r;
  }

  // ---------------------------------------------------------------- built-in lists

  const FIRST = ['Olivia', 'Charlotte', 'Amelia', 'Isla', 'Mia', 'Ava', 'Grace', 'Willow', 'Harper', 'Chloe', 'Ella', 'Sophie',
    'Zoe', 'Matilda', 'Ruby', 'Evie', 'Lily', 'Sienna', 'Emily', 'Hannah', 'Jessica', 'Sarah', 'Emma', 'Lucy', 'Georgia', 'Priya',
    'Ananya', 'Aisha', 'Fatima', 'Mei', 'Yuki', 'Hana', 'Linh', 'Mai', 'Sofia', 'Isabella', 'Maria', 'Elena', 'Leila', 'Nadia',
    'Aroha', 'Kirra', 'Jasmine', 'Rachel', 'Megan', 'Kate', 'Anna', 'Laura', 'Claire', 'Holly', 'Imogen', 'Freya', 'Alice', 'Ivy',
    'Oliver', 'Noah', 'William', 'Jack', 'Leo', 'Henry', 'Charlie', 'Thomas', 'Lucas', 'James', 'Ethan', 'Max', 'Archie', 'Hudson',
    'Harrison', 'Lachlan', 'Cooper', 'Riley', 'Mason', 'Liam', 'Samuel', 'Daniel', 'Joshua', 'Benjamin', 'Matthew', 'Nathan', 'Ryan',
    'Luke', 'Adam', 'Michael', 'David', 'Andrew', 'Peter', 'Mark', 'Paul', 'Arjun', 'Rahul', 'Vikram', 'Mohammed', 'Omar', 'Ali',
    'Hassan', 'Wei', 'Jun', 'Hiroshi', 'Minh', 'Duc', 'Tuan', 'Marco', 'Luca', 'Nikos', 'Jarrah', 'Tane', 'Sam', 'Alex', 'Hamish',
    'Angus', 'Fergus', 'Declan', 'Patrick', 'Sean'];

  const LAST = ['Smith', 'Jones', 'Williams', 'Brown', 'Wilson', 'Taylor', 'Johnson', 'White', 'Martin', 'Anderson', 'Thompson',
    'Nguyen', 'Thomas', 'Walker', 'Harris', 'Lee', 'Ryan', 'Robinson', 'Kelly', 'King', 'Davis', 'Wright', 'Evans', 'Roberts', 'Green',
    'Hall', 'Wood', 'Jackson', 'Clarke', 'Patel', 'Khan', 'Lewis', 'James', 'Phillips', 'Mitchell', 'Turner', 'Campbell', 'Murphy',
    "O'Brien", 'Kennedy', 'Collins', 'Stewart', 'Morris', 'Hughes', 'Edwards', 'Young', 'Scott', 'Baker', 'Cooper', 'Hill', 'Ward',
    'Moore', 'Clark', 'Allen', 'Bell', 'Cook', 'Murray', 'Graham', 'Hunt', 'Ross', 'Tran', 'Le', 'Pham', 'Chen', 'Wang', 'Li', 'Zhang',
    'Liu', 'Yang', 'Huang', 'Wu', 'Zhou', 'Singh', 'Kaur', 'Sharma', 'Gupta', 'Kumar', 'Shah', 'Ahmed', 'Hussain', 'Ali', 'Rossi',
    'Russo', 'Ferrari', 'Romano', 'Papadopoulos', 'Nikolaidis', 'Kowalski', 'Novak', 'Muller', 'Schmidt', 'Fischer', 'Silva',
    'Santos', 'Costa', 'Garcia', 'Rodriguez', 'Lopez', 'Martinez', 'Hernandez', 'Kim', 'Park', 'Choi', 'Tanaka', 'Sato', 'Suzuki',
    'Watanabe', 'Yamamoto', "O'Connor", 'McDonald', 'MacKenzie', 'Fraser', 'Gordon', 'Hamilton', 'Reid', 'Burns', 'Doyle', 'Byrne',
    'Walsh', 'Quinn', 'Dunn', 'Lawson', 'Barker', 'Fletcher', 'Hayes', 'Ellis', 'Shaw', 'Marshall', 'Hart', 'Bailey', 'Price', 'Webb',
    'Carter', 'Holmes', 'Mills', 'Palmer', 'Lloyd', 'Gibson', 'Chapman', 'Wells', 'Day', 'Fox', 'Stone', 'Cole', 'Lane'];

  // Real suburb, state and postcode combinations (Australia Post), across every state and territory.
  const SUBURBS = [
    ['Sydney', 'NSW', '2000'], ['Surry Hills', 'NSW', '2010'], ['Bondi', 'NSW', '2026'], ['Randwick', 'NSW', '2031'],
    ['Newtown', 'NSW', '2042'], ['Chatswood', 'NSW', '2067'], ['Hornsby', 'NSW', '2077'], ['Manly', 'NSW', '2095'],
    ['Blacktown', 'NSW', '2148'], ['Parramatta', 'NSW', '2150'], ['Liverpool', 'NSW', '2170'], ['Cronulla', 'NSW', '2230'],
    ['Gosford', 'NSW', '2250'], ['Newcastle', 'NSW', '2300'], ['Tamworth', 'NSW', '2340'], ['Port Macquarie', 'NSW', '2444'],
    ['Coffs Harbour', 'NSW', '2450'], ['Lismore', 'NSW', '2480'], ['Wollongong', 'NSW', '2500'], ['Albury', 'NSW', '2640'],
    ['Wagga Wagga', 'NSW', '2650'], ['Penrith', 'NSW', '2750'], ['Bathurst', 'NSW', '2795'], ['Orange', 'NSW', '2800'],
    ['Dubbo', 'NSW', '2830'],
    ['Melbourne', 'VIC', '3000'], ['Footscray', 'VIC', '3011'], ['Werribee', 'VIC', '3030'], ['Carlton', 'VIC', '3053'],
    ['Brunswick', 'VIC', '3056'], ['Fitzroy', 'VIC', '3065'], ['Preston', 'VIC', '3072'], ['Doncaster', 'VIC', '3108'],
    ['Richmond', 'VIC', '3121'], ['Hawthorn', 'VIC', '3122'], ['Box Hill', 'VIC', '3128'], ['Glen Waverley', 'VIC', '3150'],
    ['Dandenong', 'VIC', '3175'], ['St Kilda', 'VIC', '3182'], ['Frankston', 'VIC', '3199'], ['Geelong', 'VIC', '3220'],
    ['Warrnambool', 'VIC', '3280'], ['Ballarat', 'VIC', '3350'], ['Mildura', 'VIC', '3500'], ['Bendigo', 'VIC', '3550'],
    ['Shepparton', 'VIC', '3630'], ['Traralgon', 'VIC', '3844'],
    ['Brisbane', 'QLD', '4000'], ['Fortitude Valley', 'QLD', '4006'], ['Chermside', 'QLD', '4032'], ['Toowong', 'QLD', '4066'],
    ['South Brisbane', 'QLD', '4101'], ['Logan Central', 'QLD', '4114'], ['Southport', 'QLD', '4215'],
    ['Surfers Paradise', 'QLD', '4217'], ['Ipswich', 'QLD', '4305'], ['Toowoomba', 'QLD', '4350'], ['Maroochydore', 'QLD', '4558'],
    ['Noosa Heads', 'QLD', '4567'], ['Bundaberg', 'QLD', '4670'], ['Gladstone', 'QLD', '4680'], ['Rockhampton', 'QLD', '4700'],
    ['Mackay', 'QLD', '4740'], ['Townsville', 'QLD', '4810'], ['Cairns', 'QLD', '4870'],
    ['Perth', 'WA', '6000'], ['Subiaco', 'WA', '6008'], ['Scarborough', 'WA', '6019'], ['Joondalup', 'WA', '6027'],
    ['Midland', 'WA', '6056'], ['Armadale', 'WA', '6112'], ['Fremantle', 'WA', '6160'], ['Rockingham', 'WA', '6168'],
    ['Mandurah', 'WA', '6210'], ['Bunbury', 'WA', '6230'], ['Albany', 'WA', '6330'], ['Kalgoorlie', 'WA', '6430'],
    ['Geraldton', 'WA', '6530'],
    ['Adelaide', 'SA', '5000'], ['Glenelg', 'SA', '5045'], ['Unley', 'SA', '5061'], ['Norwood', 'SA', '5067'],
    ['Prospect', 'SA', '5082'], ['Elizabeth', 'SA', '5112'], ['Murray Bridge', 'SA', '5253'], ['Mount Gambier', 'SA', '5290'],
    ['Whyalla', 'SA', '5600'], ['Port Lincoln', 'SA', '5606'], ['Port Augusta', 'SA', '5700'],
    ['Hobart', 'TAS', '7000'], ['Sandy Bay', 'TAS', '7005'], ['Glenorchy', 'TAS', '7010'], ['Kingston', 'TAS', '7050'],
    ['Launceston', 'TAS', '7250'], ['Devonport', 'TAS', '7310'], ['Burnie', 'TAS', '7320'],
    ['Barton', 'ACT', '2600'], ['Dickson', 'ACT', '2602'], ['Kingston', 'ACT', '2604'], ['Phillip', 'ACT', '2606'],
    ['Braddon', 'ACT', '2612'], ['Belconnen', 'ACT', '2617'], ['Greenway', 'ACT', '2900'], ['Gungahlin', 'ACT', '2912'],
    ['Darwin', 'NT', '0800'], ['Casuarina', 'NT', '0810'], ['Nightcliff', 'NT', '0810'], ['Stuart Park', 'NT', '0820'],
    ['Palmerston', 'NT', '0830'], ['Katherine', 'NT', '0850'], ['Tennant Creek', 'NT', '0860'], ['Alice Springs', 'NT', '0870'],
  ];

  const STREET_NAMES = ['High', 'Main', 'Station', 'Church', 'Victoria', 'King', 'Queen', 'George', 'Elizabeth', 'Park', 'Railway',
    'Bridge', 'Albert', 'William', 'Hill', 'Lake', 'Beach', 'Ocean', 'River', 'Wattle', 'Banksia', 'Acacia', 'Jacaranda', 'Gum Tree',
    'Bay', 'Harbour', 'Garden', 'School', 'Mill', 'Forest', 'Spring', 'Hope', 'Union', 'Edward', 'Charles', 'Collins', 'Lonsdale',
    'Flinders', 'Macquarie', 'Hunter'];
  const STREET_TYPES = ['Street', 'Street', 'Street', 'Road', 'Road', 'Avenue', 'Parade', 'Crescent', 'Drive', 'Court', 'Place',
    'Lane', 'Way', 'Terrace', 'Close', 'Highway'];

  const CO_ADJ = ['Southern', 'Coastal', 'Harbour', 'Summit', 'Blue', 'Red Gum', 'Ironbark', 'Wattle', 'Banksia', 'Outback',
    'Pacific', 'Eastern', 'Western', 'Northern', 'Bright', 'Clear', 'Swift', 'True North', 'Silver', 'Golden', 'Granite', 'Riverbend',
    'Bayside', 'Highland', 'Kestrel', 'Magpie', 'Lyrebird', 'Eucalypt', 'Saltwater', 'Sunrise', 'Tasman', 'Coral', 'Frontier',
    'Keystone', 'Anchor', 'Beacon', 'Lighthouse', 'Meridian', 'Horizon', 'Kookaburra'];
  const CO_NOUN = ['Logistics', 'Analytics', 'Engineering', 'Health', 'Software', 'Consulting', 'Energy', 'Freight', 'Foods',
    'Retail', 'Insurance', 'Finance', 'Labs', 'Systems', 'Digital', 'Construction', 'Mining', 'Agriculture', 'Media', 'Security',
    'Telecom', 'Travel', 'Property', 'Legal', 'Education', 'Solutions', 'Networks', 'Payments', 'Robotics', 'Water', 'Supplies',
    'Partners', 'Group', 'Holdings', 'Ventures', 'Services', 'Data', 'Cloud', 'Design', 'Medical'];
  const CO_SUFFIX = ['Pty Ltd', 'Pty Ltd', 'Pty Ltd', 'Ltd', '& Co', ''];

  const PROD_ADJ = ['Classic', 'Premium', 'Eco', 'Compact', 'Deluxe', 'Wireless', 'Organic', 'Heavy-duty', 'Lightweight', 'Smart',
    'Travel', 'Pro', 'Mini', 'Ultra', 'Vintage', 'Bamboo', 'Stainless', 'Ceramic', 'Merino', 'Cotton'];
  const PROD_NOUN = ['Kettle', 'Toaster', 'Backpack', 'Water Bottle', 'Desk Lamp', 'Headphones', 'Coffee Grinder', 'Yoga Mat',
    'Notebook', 'Phone Case', 'Running Shoes', 'Hoodie', 'Socks', 'Beanie', 'Frying Pan', "Chef's Knife", 'Cutting Board', 'Blender',
    'Office Chair', 'Monitor Stand', 'Keyboard', 'Mouse', 'USB-C Cable', 'Power Bank', 'Sunglasses', 'Umbrella', 'Tent',
    'Sleeping Bag', 'Esky', 'Thongs'];

  const LOREM = ('lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna ' +
    'aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure ' +
    'in reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa ' +
    'qui officia deserunt mollit anim id est laborum').split(' ');

  const EMAIL_DOMAINS = ['example.com', 'example.com', 'example.net', 'example.org'];
  const BSB_PREFIX = ['01', '03', '06', '08', '11', '18', '48', '73', '76', '92'];

  // Public test card numbers published by Stripe, Braintree, Adyen and others. They pass Luhn and never charge.
  const PUBLIC_CARDS = [
    ['4111111111111111', 'Visa'], ['4242424242424242', 'Visa'], ['4012888888881881', 'Visa'], ['4000056655665556', 'Visa'],
    ['5555555555554444', 'Mastercard'], ['5105105105105100', 'Mastercard'], ['2223003122003222', 'Mastercard'],
    ['5200828282828210', 'Mastercard'],
    ['378282246310005', 'Amex'], ['371449635398431', 'Amex'],
    ['6011111111111117', 'Discover'], ['6011000990139424', 'Discover'],
    ['30569309025904', 'Diners'], ['3566002020360505', 'JCB'],
  ];
  // Test BINs used by payment sandboxes. Generated numbers get a Luhn check digit.
  const TEST_BINS = { Visa: [['411111', 16], ['424242', 16]], Mastercard: [['555555', 16], ['510510', 16], ['222300', 16]],
    Amex: [['378282', 15], ['371449', 15]] };

  // ---------------------------------------------------------------- checksums

  function luhnValid(num) {
    const s = String(num).replace(/\D/g, '');
    if (s.length < 12) return false;
    let sum = 0;
    for (let i = 0; i < s.length; i++) {
      let d = +s[s.length - 1 - i];
      if (i % 2) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    return sum % 10 === 0;
  }
  function luhnDigit(partial) {
    for (let d = 0; d < 10; d++) if (luhnValid(partial + d)) return String(d);
    return '0';
  }
  // Official TFN check: weights 1,4,3,7,5,8,6,9,10, sum divisible by 11.
  const TFN_W = [1, 4, 3, 7, 5, 8, 6, 9, 10];
  function tfnValid(tfn) {
    const s = String(tfn).replace(/\D/g, '');
    if (s.length !== 9) return false;
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += +s[i] * TFN_W[i];
    return sum % 11 === 0;
  }
  // Official Medicare check: first digit 2-6, digit 9 = sum(first 8 x 1,3,7,9,1,3,7,9) mod 10.
  const MED_W = [1, 3, 7, 9, 1, 3, 7, 9];
  function medicareCheck(s) { let sum = 0; for (let i = 0; i < 8; i++) sum += +s[i] * MED_W[i]; return sum % 10; }
  function medicareValid(num) {
    const s = String(num).replace(/\D/g, '');
    if (s.length < 10 || s.length > 11 || !/^[2-6]/.test(s)) return false;
    return medicareCheck(s) === +s[8];
  }

  // ---------------------------------------------------------------- patterns (ABC-####, [A-Z]{3}-\d{4})

  const CLS = {
    digit: '0123456789', upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', lower: 'abcdefghijklmnopqrstuvwxyz',
  };
  CLS.alnum = CLS.upper + CLS.digit;
  CLS.word = CLS.upper + CLS.lower + CLS.digit;

  function expandClass(body) {
    let out = '';
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '\\' && i + 1 < body.length) {
        const c = body[++i];
        out += c === 'd' ? CLS.digit : c === 'w' ? CLS.word : c;
      } else if (body[i + 1] === '-' && i + 2 < body.length) {
        const a = body.charCodeAt(i), b = body.charCodeAt(i + 2);
        if (b < a) throw new Error('Bad range ' + body.slice(i, i + 3) + ' in pattern');
        for (let c = a; c <= b; c++) out += String.fromCharCode(c);
        i += 2;
      } else out += body[i];
    }
    return [...new Set(out)].join('');
  }

  // Returns [{ chars, min, max }]. Literal text is a token with one char.
  function parsePattern(p) {
    p = String(p == null ? '' : p);
    if (!p) throw new Error('The pattern is empty.');
    const toks = [];
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      let chars;
      if (c === '#') chars = CLS.digit;
      else if (c === '?') chars = CLS.upper;
      else if (c === '*') chars = CLS.alnum;
      else if (c === '\\' && i + 1 < p.length) {
        const n = p[++i];
        chars = n === 'd' ? CLS.digit : n === 'w' ? CLS.word : n === 'u' ? CLS.upper : n === 'l' ? CLS.lower : n;
      } else if (c === '[') {
        const end = p.indexOf(']', i + 1);
        if (end < 0) throw new Error('Missing ] in pattern.');
        chars = expandClass(p.slice(i + 1, end));
        if (!chars) throw new Error('Empty [] in pattern.');
        i = end;
      } else chars = c;
      let min = 1, max = 1;
      const q = /^\{(\d+)(?:,(\d+))?\}/.exec(p.slice(i + 1));
      if (q) {
        min = +q[1]; max = q[2] != null ? +q[2] : min;
        if (max < min || max > 1000) throw new Error('Bad repeat ' + q[0] + ' in pattern.');
        i += q[0].length;
      }
      toks.push({ chars, min, max });
    }
    return toks;
  }

  function patternCapacity(toks) {
    let cap = 1;
    for (const t of toks) {
      let sum = 0;
      for (let k = t.min; k <= t.max; k++) sum += Math.pow(t.chars.length, k);
      cap *= sum;
    }
    return cap;
  }

  // ---------------------------------------------------------------- helpers

  const pad = (n, w) => { const s = String(n); return s.length >= w ? s : '0'.repeat(w - s.length) + s; };
  const DAY = 86400000;
  function parseDate(s, label) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
    if (!m) throw new Error((label || 'Date') + ' must look like 2024-01-31.');
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    if (isNaN(t)) throw new Error((label || 'Date') + ' is not a real date.');
    return t;
  }
  function fmtDate(t, format) {
    const d = new Date(t);
    const y = d.getUTCFullYear(), mo = pad(d.getUTCMonth() + 1, 2), da = pad(d.getUTCDate(), 2);
    if (format === 'au') return da + '/' + mo + '/' + y;
    if (format === 'us') return mo + '/' + da + '/' + y;
    if (format === 'datetime') return y + '-' + mo + '-' + da + 'T' + pad(d.getUTCHours(), 2) + ':' + pad(d.getUTCMinutes(), 2) + ':' + pad(d.getUTCSeconds(), 2) + 'Z';
    if (format === 'epoch') return Math.floor(t / 1000);
    return y + '-' + mo + '-' + da;
  }
  function slug(s) { return String(s).toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, ''); }
  function splitList(v) {
    if (Array.isArray(v)) return v.map(String);
    const s = String(v == null ? '' : v);
    return (s.includes('\n') ? s.split('\n') : s.split(',')).map(x => x.trim()).filter(x => x !== '');
  }
  function num(v, def) { const n = v === '' || v == null ? NaN : +v; return isFinite(n) ? n : def; }

  // ---------------------------------------------------------------- column types

  /* Each type builder gets (col, ctx) and returns a column generator with:
       gen(rng, row)          -> value (random, may repeat)
       capacity               -> number of distinct values (Infinity if unbounded)
       at(k, rng, row)        -> the k-th distinct value, 0 <= k < capacity (only when enumerable)
       alwaysUnique           -> true when the type guarantees uniqueness itself (sequences, emails)
     `row` is the per-row context: shared name, location and card picks so columns agree with each other. */

  const NAME_TYPES = { firstName: 1, lastName: 1, fullName: 1 };
  const LOC_TYPES = { street: 1, suburb: 1, state: 1, postcode: 1, address: 1 };
  const ORDER_TYPES = { orderId: 1, lineNo: 1, lineSku: 1, lineProduct: 1, quantity: 1, unitPrice: 1, lineTotal: 1, orderTotal: 1 };
  const DERIVED_TYPES = { email: 1, username: 1, cardBrand: 1, cardCvv: 1 };

  // name + suffix: olivia.chen, then olivia.chen2, olivia.chen3 ... never repeats
  function uniqueNamer() {
    const used = new Set(), next = new Map();
    return (local, suffix) => {
      const base = local + suffix;
      if (!used.has(base)) { used.add(base); return base; }
      let n = next.get(base) || 2, v;
      while (used.has(v = local + n + suffix)) n++;
      next.set(base, n + 1);
      used.add(v);
      return v;
    };
  }

  function first(row, rng) { if (row.first == null) row.first = rng.int(FIRST.length); return FIRST[row.first]; }
  function last(row, rng) { if (row.last == null) row.last = rng.int(LAST.length); return LAST[row.last]; }
  function loc(row, rng) { if (row.loc == null) row.loc = rng.int(SUBURBS.length); return SUBURBS[row.loc]; }
  function street(row, rng) {
    if (row.street == null) {
      const unit = rng.chance(15) ? 'Unit ' + rng.range(1, 40) + '/' : '';
      row.street = unit + rng.range(1, 320) + ' ' + rng.pick(STREET_NAMES) + ' ' + rng.pick(STREET_TYPES);
    }
    return row.street;
  }
  // Distinct values of one SUBURBS field, and the suburbs that have each value.
  function locIndex(field) {
    const vals = [], map = new Map();
    SUBURBS.forEach((s, i) => { const v = s[field]; if (!map.has(v)) { map.set(v, []); vals.push(v); } map.get(v).push(i); });
    return { vals, map };
  }

  function card(row, rng, col) {
    if (row.card) return row.card;
    const brandOpt = col.brand || 'any';
    if ((col.mode || 'public') === 'public') {
      const list = brandOpt === 'any' ? PUBLIC_CARDS : PUBLIC_CARDS.filter(c => c[1].toLowerCase() === brandOpt.toLowerCase());
      const c = rng.pick(list.length ? list : PUBLIC_CARDS);
      row.card = { number: c[0], brand: c[1] };
    } else {
      const brands = brandOpt === 'any' || !TEST_BINS[cap1(brandOpt)] ? Object.keys(TEST_BINS) : [cap1(brandOpt)];
      const brand = rng.pick(brands);
      const [bin, len] = rng.pick(TEST_BINS[brand]);
      let s = bin;
      while (s.length < len - 1) s += rng.int(10);
      row.card = { number: s + luhnDigit(s), brand };
    }
    return row.card;
  }
  function cap1(s) { s = String(s).toLowerCase(); return s === 'amex' ? 'Amex' : s.charAt(0).toUpperCase() + s.slice(1); }

  const TYPES = {
    id(col) {
      if ((col.mode || 'sequence') === 'uuid') {
        return {
          capacity: Infinity,
          gen(rng) {
            const h = '0123456789abcdef';
            let s = '';
            for (let i = 0; i < 32; i++) {
              let d = rng.int(16);
              if (i === 12) d = 4;
              else if (i === 16) d = 8 + (d & 3);
              s += h[d];
              if (i === 7 || i === 11 || i === 15 || i === 19) s += '-';
            }
            return s;
          },
        };
      }
      const start = Math.floor(num(col.start, 1)), step = Math.floor(num(col.step, 1)) || 1;
      const prefix = col.prefix || '', w = Math.max(0, Math.min(20, Math.floor(num(col.pad, 0))));
      let i = 0;
      const plain = !prefix && !w;
      return {
        capacity: Infinity, alwaysUnique: true, numeric: plain,
        gen() { const n = start + step * i++; return plain ? n : prefix + pad(n, w); },
      };
    },

    firstName() {
      return { capacity: FIRST.length, gen: (rng, row) => first(row, rng), at: (k, rng, row) => { row.first = k; return FIRST[k]; } };
    },
    lastName() {
      return { capacity: LAST.length, gen: (rng, row) => last(row, rng), at: (k, rng, row) => { row.last = k; return LAST[k]; } };
    },
    fullName() {
      return {
        capacity: FIRST.length * LAST.length,
        gen: (rng, row) => first(row, rng) + ' ' + last(row, rng),
        at(k, rng, row) { row.first = k % FIRST.length; row.last = Math.floor(k / FIRST.length); return FIRST[row.first] + ' ' + LAST[row.last]; },
      };
    },

    email(col) {
      const uniq = uniqueNamer();
      const domain = (col.domain || '').trim().replace(/^@/, '');
      return {
        capacity: Infinity, alwaysUnique: true,
        gen(rng, row) {
          const f = slug(first(row, rng)), l = slug(last(row, rng));
          const style = rng.int(4);
          const local = style === 0 ? f + '.' + l : style === 1 ? f + l : style === 2 ? f[0] + '.' + l : f + '_' + l;
          const dom = '@' + (domain || rng.pick(EMAIL_DOMAINS));
          return uniq(local, dom);
        },
      };
    },

    username(col) {
      if ((col.style || 'sequence') === 'sequence') {
        const prefix = col.prefix == null ? 'loadtest_user_' : col.prefix, w = Math.floor(num(col.pad, 5));
        const start = Math.floor(num(col.start, 1));
        let i = 0;
        return { capacity: Infinity, alwaysUnique: true, gen: () => prefix + pad(start + i++, w) };
      }
      const uniq = uniqueNamer();
      return { capacity: Infinity, alwaysUnique: true, gen: (rng, row) => uniq(slug(first(row, rng)) + '.' + slug(last(row, rng)), '') };
    },

    mobile() {
      const f = k => { const s = pad(k, 8); return '04' + s.slice(0, 2) + ' ' + s.slice(2, 5) + ' ' + s.slice(5); };
      return { capacity: 1e8, gen: rng => f(rng.int(1e8)), at: k => f(k) };
    },

    street() { return { capacity: Infinity, gen: (rng, row) => street(row, rng) }; },
    address() {
      return { capacity: Infinity, gen: (rng, row) => { const s = loc(row, rng); return street(row, rng) + ', ' + s[0] + ' ' + s[1] + ' ' + s[2]; } };
    },
    suburb: locType(0), state: locType(1), postcode: locType(2),

    date(col) {
      const lo = parseDate(col.min || '2020-01-01', 'From date'), hi = parseDate(col.max || '2025-12-31', 'To date');
      if (hi < lo) throw new Error('Column "' + col.name + '": the To date is before the From date.');
      const fmt = col.format || 'iso';
      if (fmt === 'datetime' || fmt === 'epoch') {
        const secs = Math.floor((hi - lo) / 1000) + 86400;
        return { capacity: secs, gen: rng => fmtDate(lo + rng.int(secs) * 1000, fmt), at: k => fmtDate(lo + k * 1000, fmt), numeric: fmt === 'epoch' };
      }
      const days = Math.round((hi - lo) / DAY) + 1;
      return { capacity: days, gen: rng => fmtDate(lo + rng.int(days) * DAY, fmt), at: k => fmtDate(lo + k * DAY, fmt) };
    },

    int(col) {
      const lo = Math.ceil(num(col.min, 1)), hi = Math.floor(num(col.max, 100));
      if (hi < lo) throw new Error('Column "' + col.name + '": max is below min.');
      return { capacity: hi - lo + 1, numeric: true, gen: rng => lo + rng.int(hi - lo + 1), at: k => lo + k };
    },

    decimal(col) {
      const dp = Math.max(0, Math.min(6, Math.floor(num(col.dp, 2)))), f = Math.pow(10, dp);
      const lo = Math.round(num(col.min, 0) * f), hi = Math.round(num(col.max, 1000) * f);
      if (hi < lo) throw new Error('Column "' + col.name + '": max is below min.');
      return { capacity: hi - lo + 1, numeric: true, dp, gen: rng => (lo + rng.int(hi - lo + 1)) / f, at: k => (lo + k) / f };
    },

    enum(col) {
      const vals = splitList(col.values);
      if (!vals.length) throw new Error('Column "' + col.name + '": add at least one value to pick from.');
      const w = splitList(col.weights).map(Number);
      const weighted = w.length === vals.length && w.every(x => x >= 0) && w.some(x => x > 0);
      let cum = null, total = 0;
      if (weighted) { cum = w.map(x => (total += x)); }
      return {
        capacity: vals.length,
        gen(rng) {
          if (!weighted) return rng.pick(vals);
          const r = rng.next() * total;
          for (let i = 0; i < cum.length; i++) if (r < cum[i]) return vals[i];
          return vals[vals.length - 1];
        },
        at: k => vals[k],
      };
    },

    bool(col) {
      const pct = Math.max(0, Math.min(100, num(col.pct, 50)));
      return { capacity: 2, bool: true, gen: rng => rng.chance(pct), at: k => k === 1 };
    },

    constant(col) { const v = col.value == null ? '' : String(col.value); return { capacity: 1, gen: () => v, at: () => v }; },

    pattern(col) {
      const toks = parsePattern(col.pattern || '');
      const fixed = toks.every(t => t.min === t.max);
      const cap = patternCapacity(toks);
      const g = {
        capacity: cap,
        gen(rng) {
          let s = '';
          for (const t of toks) {
            const n = t.min === t.max ? t.min : t.min + rng.int(t.max - t.min + 1);
            for (let i = 0; i < n; i++) s += t.chars.length === 1 ? t.chars : t.chars[rng.int(t.chars.length)];
          }
          return s;
        },
      };
      if (fixed && cap <= 9e15) {
        g.at = k => {
          // mixed radix, least significant position last
          const out = [];
          for (let ti = toks.length - 1; ti >= 0; ti--) {
            const t = toks[ti];
            for (let i = 0; i < t.min; i++) { const b = t.chars.length; out.push(t.chars[k % b]); k = Math.floor(k / b); }
          }
          return out.reverse().join('');
        };
      }
      return g;
    },

    company() {
      const a = CO_ADJ.length, n = CO_NOUN.length, s = CO_SUFFIX.length;
      const f = (i, j, k) => (CO_ADJ[i] + ' ' + CO_NOUN[j] + (CO_SUFFIX[k] ? ' ' + CO_SUFFIX[k] : ''));
      return { capacity: a * n * s, gen: rng => f(rng.int(a), rng.int(n), rng.int(s)), at: k => f(k % a, Math.floor(k / a) % n, Math.floor(k / (a * n))) };
    },

    productName() {
      const a = PROD_ADJ.length, n = PROD_NOUN.length;
      return { capacity: a * n, gen: rng => PROD_ADJ[rng.int(a)] + ' ' + PROD_NOUN[rng.int(n)], at: k => PROD_ADJ[k % a] + ' ' + PROD_NOUN[Math.floor(k / a)] };
    },

    sentence(col) {
      const lo = Math.max(1, Math.floor(num(col.min, 6))), hi = Math.max(lo, Math.floor(num(col.max, 14)));
      return {
        capacity: Infinity,
        gen(rng) {
          const n = rng.range(lo, hi), w = [];
          for (let i = 0; i < n; i++) w.push(rng.pick(LOREM));
          if (n > 7 && rng.chance(40)) w[rng.range(2, n - 3)] += ',';
          const s = w.join(' ');
          return s.charAt(0).toUpperCase() + s.slice(1) + '.';
        },
      };
    },

    password(col) {
      const len = Math.max(4, Math.min(128, Math.floor(num(col.length, 14))));
      const sets = [];
      if (col.upper !== false) sets.push('ABCDEFGHJKLMNPQRSTUVWXYZ');
      if (col.lower !== false) sets.push('abcdefghijkmnopqrstuvwxyz');
      if (col.digit !== false) sets.push('23456789');
      if (col.symbol !== false) sets.push('!#$%^&*_?'); // no = + - @, which spreadsheets read as formulas
      if (!sets.length) sets.push('abcdefghijkmnopqrstuvwxyz');
      if (len < sets.length) throw new Error('Column "' + col.name + '": the password is too short to include every character type.');
      const all = sets.join('');
      return {
        capacity: Infinity,
        gen(rng) {
          const c = sets.map(s => s[rng.int(s.length)]);
          while (c.length < len) c.push(all[rng.int(all.length)]);
          for (let i = c.length - 1; i > 0; i--) { const j = rng.int(i + 1); const t = c[i]; c[i] = c[j]; c[j] = t; }
          return c.join('');
        },
      };
    },

    bsb() {
      const P = BSB_PREFIX.length;
      const f = (p, n) => { const s = BSB_PREFIX[p] + pad(n, 4); return s.slice(0, 3) + '-' + s.slice(3); };
      return { capacity: P * 10000, gen: rng => f(rng.int(P), rng.int(10000)), at: k => f(k % P, Math.floor(k / P)) };
    },
    accountNumber() {
      return { capacity: 9e8, gen: rng => String(100000000 + rng.int(9e8)), at: k => String(100000000 + k) };
    },

    cardNumber(col) { return { capacity: col.mode === 'luhn' ? Infinity : PUBLIC_CARDS.length, gen: (rng, row) => card(row, rng, col).number }; },
    cardBrand(col) { return { capacity: Infinity, gen: (rng, row) => card(row, rng, row.cardCol || col).brand }; },
    cardExpiry(col) {
      const y0 = Math.floor(num(col.from, new Date().getFullYear() + 1)), y1 = Math.max(y0, Math.floor(num(col.to, y0 + 4)));
      return { capacity: (y1 - y0 + 1) * 12, gen: rng => pad(rng.range(1, 12), 2) + '/' + pad(rng.range(y0, y1) % 100, 2) };
    },
    cardCvv(col) {
      return { capacity: Infinity, gen: (rng, row) => { const amex = row.card && row.card.brand === 'Amex'; return amex ? pad(rng.int(10000), 4) : pad(rng.int(1000), 3); } };
    },

    fakeTfn() {
      return {
        capacity: Infinity,
        gen(rng) {
          const d = [];
          for (let i = 0; i < 9; i++) d.push(rng.int(10));
          let s = d.join('');
          while (tfnValid(s)) { d[8] = (d[8] + 1) % 10; s = d.join(''); }
          return s.slice(0, 3) + ' ' + s.slice(3, 6) + ' ' + s.slice(6);
        },
      };
    },
    fakeMedicare() {
      return {
        capacity: Infinity,
        gen(rng) {
          let s = String(rng.range(2, 6));
          for (let i = 0; i < 7; i++) s += rng.int(10);
          const bad = (medicareCheck(s) + 1 + rng.int(9)) % 10; // never the right check digit
          s += bad + String(rng.range(1, 9));
          return s.slice(0, 4) + ' ' + s.slice(4, 9) + ' ' + s.slice(9);
        },
      };
    },

    // ---- order lines: rows are lines, grouped into orders whose total adds up
    orderId(col, ctx) { return { capacity: Infinity, gen: (rng, row) => ctx.order(rng, row).id }; },
    lineNo(col, ctx) { return { capacity: Infinity, numeric: true, gen: (rng, row) => ctx.order(rng, row).lineNo }; },
    lineSku(col, ctx) { return { capacity: Infinity, gen: (rng, row) => ctx.order(rng, row).line.sku }; },
    lineProduct(col, ctx) { return { capacity: Infinity, gen: (rng, row) => ctx.order(rng, row).line.name }; },
    quantity(col, ctx) { return { capacity: Infinity, numeric: true, gen: (rng, row) => ctx.order(rng, row).line.qty }; },
    unitPrice(col, ctx) { return { capacity: Infinity, numeric: true, dp: 2, gen: (rng, row) => ctx.order(rng, row).line.price / 100 }; },
    lineTotal(col, ctx) { return { capacity: Infinity, numeric: true, dp: 2, gen: (rng, row) => ctx.order(rng, row).line.total / 100 }; },
    orderTotal(col, ctx) { return { capacity: Infinity, numeric: true, dp: 2, gen: (rng, row) => ctx.order(rng, row).total / 100 }; },
  };

  function locType(field) {
    return function () {
      const idx = locIndex(field);
      return {
        capacity: idx.vals.length,
        gen: (rng, row) => loc(row, rng)[field],
        at(k, rng, row) { const list = idx.map.get(idx.vals[k]); row.loc = list[rng.int(list.length)]; return idx.vals[k]; },
      };
    };
  }

  const TYPE_LABELS = {
    id: 'ID (sequence or UUID)', firstName: 'First name', lastName: 'Last name', fullName: 'Full name', email: 'Email (from the name)',
    username: 'Username', mobile: 'Australian mobile', street: 'Street address', suburb: 'Suburb', state: 'State', postcode: 'Postcode',
    address: 'Full address', date: 'Date', int: 'Whole number', decimal: 'Decimal number', enum: 'One of a list', bool: 'True / false',
    constant: 'Same value every row', pattern: 'Pattern (ABC-####)', company: 'Company name', productName: 'Product name',
    sentence: 'Lorem sentence', password: 'Password', bsb: 'BSB', accountNumber: 'Bank account number',
    cardNumber: 'Test card number', cardBrand: 'Card brand', cardExpiry: 'Card expiry (MM/YY)', cardCvv: 'Card CVV',
    fakeTfn: 'Fake TFN (fails checksum)', fakeMedicare: 'Fake Medicare no. (fails checksum)',
    orderId: 'Order: order ID', lineNo: 'Order: line number', lineSku: 'Order: SKU', lineProduct: 'Order: product name',
    quantity: 'Order: quantity', unitPrice: 'Order: unit price', lineTotal: 'Order: line total', orderTotal: 'Order: order total',
  };

  // ---------------------------------------------------------------- the generator

  // Picks k distinct indexes from [0, n) in random order (sparse Fisher-Yates, memory grows with draws, not n).
  function uniqueDrawer(n) {
    const swap = new Map();
    let i = 0;
    return rng => {
      const j = i + rng.int(n - i);
      const vj = swap.has(j) ? swap.get(j) : j;
      swap.set(j, swap.has(i) ? swap.get(i) : i);
      swap.delete(i);
      i++;
      return vj;
    };
  }

  class NotEnoughUnique extends Error {
    constructor(msg, column, capacity) { super(msg); this.code = 'NOT_ENOUGH_UNIQUE'; this.column = column; this.capacity = capacity; }
  }

  function fmtInt(n) { return Number(n).toLocaleString('en-AU'); }

  function normaliseSpec(spec) {
    if (!spec || !Array.isArray(spec.columns) || !spec.columns.length) throw new Error('Add at least one column.');
    const rows = Math.floor(num(spec.rows, 100));
    if (!(rows >= 1 && rows <= MAX_ROWS)) throw new Error('Rows must be between 1 and ' + fmtInt(MAX_ROWS) + '.');
    const seen = new Set();
    const columns = spec.columns.map((c, i) => {
      const name = String(c.name == null ? '' : c.name).trim();
      if (!name) throw new Error('Column ' + (i + 1) + ' needs a name.');
      if (seen.has(name)) throw new Error('Two columns are called "' + name + '". Column names must be different.');
      seen.add(name);
      if (!TYPES[c.type]) throw new Error('Column "' + name + '" has an unknown type: ' + c.type);
      return Object.assign({}, c, { name });
    });
    return { rows, seed: spec.seed == null || spec.seed === '' ? '1' : String(spec.seed), columns };
  }

  // Returns an object with next() -> row (or null when done), so callers can run it in chunks.
  function createGenerator(rawSpec) {
    const spec = normaliseSpec(rawSpec);
    const rng = makeRng(spec.seed);
    const total = spec.rows;
    let produced = 0;

    // order state, shared by the order-line column types
    const catalogue = [];
    const ctx = {
      cur: null, count: 0,
      order(r, row) {
        if (row.orderLine) return row.orderLine;
        if (!catalogue.length) {
          const crng = makeRng(spec.seed + ':catalogue');
          const draw = uniqueDrawer(90000);
          const pn = TYPES.productName();
          for (let i = 0; i < 250; i++) {
            const price = Math.round(Math.exp(Math.log(299) + crng.next() * (Math.log(49999) - Math.log(299))));
            catalogue.push({ sku: 'SKU-' + (10000 + draw(crng)), name: pn.gen(crng), price: Math.round(price / 10) * 10 - 1 });
          }
        }
        let o = ctx.cur;
        if (!o || o.next >= o.lines.length) {
          const left = total - produced;
          const n = Math.min(left, 1 + (r.chance(45) ? 0 : r.int(4)));
          const lines = [];
          const picked = new Set();
          for (let i = 0; i < n; i++) {
            let p;
            do { p = catalogue[r.int(catalogue.length)]; } while (picked.has(p.sku));
            picked.add(p.sku);
            const qty = r.chance(70) ? 1 : r.range(2, 5);
            lines.push({ sku: p.sku, name: p.name, qty, price: p.price, total: qty * p.price });
          }
          o = ctx.cur = { id: 'ORD-' + (100001 + ctx.count++), lines, next: 0,
            total: lines.reduce((s, l) => s + l.total, 0) };
        }
        row.orderLine = { id: o.id, lineNo: o.next + 1, line: o.lines[o.next], total: o.total };
        o.next++;
        return row.orderLine;
      },
    };

    const hasOrder = spec.columns.some(c => ORDER_TYPES[c.type]);
    const cardCol = spec.columns.find(c => c.type === 'cardNumber');

    const cols = spec.columns.map(c => {
      const g = TYPES[c.type](c, ctx);
      const unique = !!c.unique && !g.alwaysUnique;
      if (unique && g.capacity < total) {
        const what = g.capacity === 1 ? 'only one value' : 'only ' + fmtInt(g.capacity) + ' different values';
        throw new NotEnoughUnique('Column "' + c.name + '" can make ' + what + ', but you asked for ' + fmtInt(total) +
          ' unique rows. Widen its range, add values, untick Unique or ask for fewer rows.', c.name, g.capacity);
      }
      return {
        spec: c, g, unique,
        perOrder: hasOrder && !!c.perOrder && !ORDER_TYPES[c.type],
        draw: unique && g.at ? uniqueDrawer(g.capacity) : null,
        seen: unique && !g.at ? new Set() : null,
        prio: (c.unique && (NAME_TYPES[c.type] || LOC_TYPES[c.type])) ? 0 : (c.type === 'cardNumber' ? 1 : NAME_TYPES[c.type] || LOC_TYPES[c.type] ? 2 : DERIVED_TYPES[c.type] ? 4 : 3),
      };
    });
    // generate in dependency order (names and places before emails), output in the user's order
    const order = cols.slice().sort((a, b) => a.prio - b.prio);
    let prevRow = null;

    function value(c, row) {
      const g = c.g;
      if (c.draw) return g.at(c.draw(rng), rng, row);
      if (c.seen) {
        for (let tries = 0; tries < 200; tries++) {
          const v = g.gen(rng, row);
          // names/places live in the row context, so clear them before trying again
          if (!c.seen.has(v)) { c.seen.add(v); return v; }
          if (NAME_TYPES[c.spec.type]) { row.first = row.last = null; }
          if (LOC_TYPES[c.spec.type]) { row.loc = null; row.street = null; }
          if (c.spec.type === 'cardNumber') row.card = null;
        }
        throw new NotEnoughUnique('Column "' + c.spec.name + '" ran out of unique values after ' + fmtInt(produced) +
          ' rows. Make it less strict (longer pattern, more words) or untick Unique.', c.spec.name, produced);
      }
      return g.gen(rng, row);
    }

    return {
      total,
      columns: spec.columns.map((c, i) => ({ name: c.name, type: c.type, numeric: !!cols[i].g.numeric, bool: !!cols[i].g.bool, dp: cols[i].g.dp })),
      get produced() { return produced; },
      next() {
        if (produced >= total) return null;
        const row = { cardCol };
        const out = {};
        let firstLine = true;
        if (hasOrder) { ctx.order(rng, row); firstLine = row.orderLine.lineNo === 1; }
        for (const c of order) {
          if (c.perOrder && !firstLine && prevRow) out[c.spec.name] = prevRow[c.spec.name];
          else out[c.spec.name] = value(c, row);
        }
        // put keys in the user's column order
        const res = {};
        for (const c of cols) res[c.spec.name] = out[c.spec.name];
        produced++;
        prevRow = res;
        return res;
      },
    };
  }

  function generate(spec) {
    const gen = createGenerator(spec);
    const rows = new Array(gen.total);
    for (let i = 0; i < gen.total; i++) rows[i] = gen.next();
    return { columns: gen.columns, rows };
  }

  // ---------------------------------------------------------------- output

  function cellText(col, v) {
    if (v == null) return '';
    if (typeof v === 'number' && col && col.dp != null) return v.toFixed(col.dp);
    return String(v);
  }

  function csvField(s, delim) {
    return /[",\r\n]/.test(s) || s.includes(delim) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // RFC 4180 CSV with a header row. Works with papaparse ({ header: true }) and JMeter CSV Data Set Config.
  function toCSV(result, opts) {
    opts = opts || {};
    const d = opts.delimiter || ',', eol = opts.eol || '\n';
    const cols = result.columns;
    const out = [cols.map(c => csvField(c.name, d)).join(d)];
    for (const r of result.rows) {
      let line = '';
      for (let i = 0; i < cols.length; i++) {
        if (i) line += d;
        line += csvField(cellText(cols[i], r[cols[i].name]), d);
      }
      out.push(line);
    }
    return out.join(eol) + eol;
  }

  // True when some field needs quotes, so JMeter needs "Allow quoted data? = True".
  function csvNeedsQuotes(result, delimiter) {
    const d = delimiter || ',';
    for (const c of result.columns) if (csvField(c.name, d) !== c.name) return true;
    for (const r of result.rows) {
      for (const c of result.columns) {
        const s = cellText(c, r[c.name]);
        if (csvField(s, d) !== s) return true;
      }
    }
    return false;
  }

  function toJSON(result) {
    const cols = result.columns;
    const fix = r => {
      if (!cols.some(c => c.dp != null)) return r;
      const o = {};
      for (const c of cols) { const v = r[c.name]; o[c.name] = typeof v === 'number' && c.dp != null ? +v.toFixed(c.dp) : v; }
      return o;
    };
    return '[\n' + result.rows.map(r => '  ' + JSON.stringify(fix(r))).join(',\n') + '\n]\n';
  }

  /* Dialects: 'standard' (PostgreSQL, SQLite, Oracle and others), 'mysql' (MySQL, MariaDB), 'sqlserver'.
     Quotes are doubled everywhere. MySQL also treats backslash as an escape by default, so it is doubled there. */
  function sqlIdent(name, dialect) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return name;
    if (dialect === 'mysql') return '`' + String(name).replace(/`/g, '``') + '`';
    if (dialect === 'sqlserver') return '[' + String(name).replace(/]/g, ']]') + ']';
    return '"' + String(name).replace(/"/g, '""') + '"';
  }
  function sqlValue(col, v, dialect) {
    if (v == null) return 'NULL';
    if (typeof v === 'boolean') return dialect === 'sqlserver' ? (v ? '1' : '0') : v ? 'TRUE' : 'FALSE';
    if (typeof v === 'number' && isFinite(v)) return cellText(col, v);
    let s = String(v).replace(/'/g, "''");
    if (dialect === 'mysql') s = s.replace(/\\/g, '\\\\');
    return (dialect === 'sqlserver' && /[^\x00-\x7f]/.test(s) ? "N'" : "'") + s + "'";
  }

  // Multi-row INSERT statements. Batches of 500 keep each statement a sensible size (SQL Server allows 1,000).
  function toSQL(result, opts) {
    opts = opts || {};
    const dialect = opts.dialect || 'standard';
    const table = String(opts.table || 'test_data').trim() || 'test_data';
    const tname = table.split('.').map(t => sqlIdent(t, dialect)).join('.');
    const batch = Math.max(1, Math.min(1000, Math.floor(num(opts.batch, 500))));
    const cols = result.columns;
    const head = 'INSERT INTO ' + tname + ' (' + cols.map(c => sqlIdent(c.name, dialect)).join(', ') + ') VALUES\n';
    const out = [];
    for (let i = 0; i < result.rows.length; i += batch) {
      const chunk = result.rows.slice(i, i + batch).map(r => '  (' + cols.map(c => sqlValue(c, r[c.name], dialect)).join(', ') + ')');
      out.push(head + chunk.join(',\n') + ';');
    }
    return out.join('\n\n') + '\n';
  }

  // ---------------------------------------------------------------- templates

  function templates(year) {
    const y = year || new Date().getFullYear();
    return {
      users: { label: 'Users', file: 'users', columns: [
        { name: 'id', type: 'id', mode: 'sequence', start: 1 },
        { name: 'first_name', type: 'firstName' },
        { name: 'last_name', type: 'lastName' },
        { name: 'email', type: 'email' },
        { name: 'mobile', type: 'mobile' },
        { name: 'date_of_birth', type: 'date', min: (y - 80) + '-01-01', max: (y - 19) + '-12-31', format: 'iso' },
        { name: 'street', type: 'street' },
        { name: 'suburb', type: 'suburb' },
        { name: 'state', type: 'state' },
        { name: 'postcode', type: 'postcode' },
      ] },
      customers: { label: 'Customers with accounts', file: 'customers', columns: [
        { name: 'customer_id', type: 'id', mode: 'sequence', prefix: 'CUST-', pad: 6, start: 1 },
        { name: 'full_name', type: 'fullName' },
        { name: 'email', type: 'email' },
        { name: 'mobile', type: 'mobile' },
        { name: 'bsb', type: 'bsb' },
        { name: 'account_number', type: 'accountNumber', unique: true },
        { name: 'account_type', type: 'enum', values: 'Everyday, Savings, Term deposit, Home loan', weights: '5, 3, 1, 1' },
        { name: 'balance', type: 'decimal', min: -500, max: 250000, dp: 2 },
        { name: 'opened_on', type: 'date', min: '2005-01-01', max: (y - 1) + '-12-31', format: 'iso' },
        { name: 'state', type: 'state' },
      ] },
      orders: { label: 'Orders with lines', file: 'orders', columns: [
        { name: 'order_id', type: 'orderId' },
        { name: 'order_date', type: 'date', min: (y - 1) + '-01-01', max: (y - 1) + '-12-31', format: 'iso', perOrder: true },
        { name: 'customer_email', type: 'email', perOrder: true },
        { name: 'line_no', type: 'lineNo' },
        { name: 'sku', type: 'lineSku' },
        { name: 'product', type: 'lineProduct' },
        { name: 'quantity', type: 'quantity' },
        { name: 'unit_price', type: 'unitPrice' },
        { name: 'line_total', type: 'lineTotal' },
        { name: 'order_total', type: 'orderTotal' },
        { name: 'status', type: 'enum', values: 'Paid, Shipped, Delivered, Refunded', weights: '2, 3, 8, 1', perOrder: true },
      ] },
      products: { label: 'Products', file: 'products', columns: [
        { name: 'product_id', type: 'id', mode: 'sequence', start: 1 },
        { name: 'sku', type: 'pattern', pattern: 'SKU-#####', unique: true },
        { name: 'name', type: 'productName' },
        { name: 'category', type: 'enum', values: 'Kitchen, Outdoor, Clothing, Electronics, Office, Fitness' },
        { name: 'price', type: 'decimal', min: 2.5, max: 499.99, dp: 2 },
        { name: 'stock', type: 'int', min: 0, max: 500 },
        { name: 'active', type: 'bool', pct: 90 },
        { name: 'description', type: 'sentence', min: 6, max: 14 },
      ] },
      credentials: { label: 'Login credentials', file: 'credentials', columns: [
        { name: 'vu', type: 'id', mode: 'sequence', start: 1 },
        { name: 'username', type: 'username', style: 'sequence', prefix: 'loadtest_user_', pad: 5 },
        { name: 'password', type: 'password', length: 14 },
        { name: 'email', type: 'email' },
      ] },
      cards: { label: 'Test payment cards', file: 'test-cards', columns: [
        { name: 'id', type: 'id', mode: 'sequence', start: 1 },
        { name: 'cardholder', type: 'fullName' },
        { name: 'test_card_number', type: 'cardNumber', mode: 'public', brand: 'any' },
        { name: 'brand', type: 'cardBrand' },
        { name: 'expiry', type: 'cardExpiry', from: y + 1, to: y + 5 },
        { name: 'cvv', type: 'cardCvv' },
      ] },
      negative: { label: 'Fake TFN and Medicare', file: 'fake-ids', columns: [
        { name: 'id', type: 'id', mode: 'sequence', start: 1 },
        { name: 'full_name', type: 'fullName' },
        { name: 'date_of_birth', type: 'date', min: (y - 80) + '-01-01', max: (y - 19) + '-12-31', format: 'au' },
        { name: 'fake_tfn', type: 'fakeTfn' },
        { name: 'fake_medicare', type: 'fakeMedicare' },
      ] },
      custom: { label: 'Custom', file: 'test-data', columns: [
        { name: 'id', type: 'id', mode: 'uuid' },
        { name: 'reference', type: 'pattern', pattern: 'ABC-######', unique: true },
        { name: 'created', type: 'date', min: (y - 1) + '-01-01', max: (y - 1) + '-12-31', format: 'datetime' },
      ] },
    };
  }

  const api = {
    MAX_ROWS, makeRng, hashSeed, createGenerator, generate, toCSV, toJSON, toSQL, csvNeedsQuotes, cellText, csvField,
    luhnValid, tfnValid, medicareValid, parsePattern, patternCapacity, templates, TYPE_LABELS, TYPES: Object.keys(TYPES),
    SUBURBS, PUBLIC_CARDS, NotEnoughUnique,
  };

  // ---------------------------------------------------------------- Web Worker mode

  const inWorker = typeof importScripts === 'function' && typeof window === 'undefined' && typeof module === 'undefined';
  if (inWorker) {
    let last = null;
    self.onmessage = e => {
      const m = e.data || {};
      try {
        if (m.cmd === 'generate') {
          const t0 = Date.now();
          const gen = createGenerator(m.spec);
          const rows = new Array(gen.total);
          for (let i = 0; i < gen.total; i++) {
            rows[i] = gen.next();
            if ((i + 1) % 5000 === 0) self.postMessage({ type: 'progress', id: m.id, done: i + 1, total: gen.total });
          }
          last = { columns: gen.columns, rows };
          self.postMessage({ type: 'done', id: m.id, columns: gen.columns, preview: rows.slice(0, 20), count: rows.length,
            ms: Date.now() - t0, needsQuotes: csvNeedsQuotes(last) });
        } else if (m.cmd === 'export') {
          if (!last) throw new Error('Generate some data first.');
          const text = m.fmt === 'json' ? toJSON(last) : m.fmt === 'sql' ? toSQL(last, m.opts) : toCSV(last, m.opts);
          self.postMessage({ type: 'file', id: m.id, fmt: m.fmt, text });
        }
      } catch (err) {
        self.postMessage({ type: 'error', id: m.id, message: err.message || String(err), code: err.code || '' });
      }
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TestData = api;
})(typeof self !== 'undefined' ? self : this);
