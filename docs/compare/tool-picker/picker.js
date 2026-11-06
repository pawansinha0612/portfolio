// Load testing tool picker: scores each tool against the answers and returns a recommendation and a runner-up.
// The scoring is plain data so it can be tested in Node: require('./picker.js').pick(answers).
// In the browser it also wires up the form on /compare/tool-picker/.
(function (root) {
  'use strict';

  var TOOLS = {
    k6: { name: 'k6', links: [['/guides/k6/getting-started/', 'Getting started with k6'], ['/guides/k6/ci-pipelines/', 'k6 in CI pipelines'], ['/course/k6/', 'Free k6 email course']] },
    jmeter: { name: 'JMeter', links: [['/guides/jmeter/getting-started/', 'Getting started with JMeter'], ['/guides/jmeter/correlation/', 'Correlation in JMeter'], ['/tools/jtl-analyser/', 'JTL results analyser']] },
    gatling: { name: 'Gatling', links: [['/compare/jmeter-vs-gatling/', 'JMeter vs Gatling'], ['/compare/k6-vs-gatling/', 'k6 vs Gatling'], ['https://docs.gatling.io/', 'Gatling documentation']] },
    locust: { name: 'Locust', links: [['/compare/k6-vs-locust/', 'k6 vs Locust'], ['/compare/locust-vs-artillery/', 'Locust vs Artillery'], ['https://docs.locust.io/', 'Locust documentation']] },
    artillery: { name: 'Artillery', links: [['/compare/k6-vs-artillery/', 'k6 vs Artillery'], ['/compare/locust-vs-artillery/', 'Locust vs Artillery'], ['https://www.artillery.io/docs', 'Artillery documentation']] },
    loadrunner: { name: 'LoadRunner (OpenText Performance Engineering)', short: 'LoadRunner', links: [['/compare/jmeter-vs-loadrunner/', 'JMeter vs LoadRunner'], ['/guides/jmeter/correlation/', 'Correlation explained']] },
    neoload: { name: 'NeoLoad', links: [['/compare/jmeter-vs-neoload/', 'JMeter vs NeoLoad'], ['/guides/jmeter/correlation/', 'Correlation explained']] }
  };
  var ORDER = ['k6', 'jmeter', 'gatling', 'locust', 'artillery', 'loadrunner', 'neoload']; // tie-break order

  // Comparison pages that exist, keyed by the two tool ids in ORDER order.
  var PAIRS = {
    'k6|jmeter': 'k6-vs-jmeter', 'k6|gatling': 'k6-vs-gatling', 'k6|locust': 'k6-vs-locust', 'k6|artillery': 'k6-vs-artillery',
    'jmeter|loadrunner': 'jmeter-vs-loadrunner', 'jmeter|gatling': 'jmeter-vs-gatling', 'jmeter|neoload': 'jmeter-vs-neoload',
    'locust|artillery': 'locust-vs-artillery'
  };

  // RULES[question][answer] = { tool: [points, reason] }. A reason is shown when the points are positive.
  var RULES = {
    lang: {
      js: { k6: [4, 'Tests are JavaScript or TypeScript, the language your team already writes.'],
            artillery: [3, 'YAML scenarios with JavaScript hooks and npm packages suit a JavaScript team.'],
            gatling: [1, 'Has a JavaScript and TypeScript SDK, though tests still run on the JVM.'] },
      jvm: { gatling: [4, 'Tests are code in Java, Kotlin or Scala, built with Maven or Gradle like the rest of your work.'],
             jmeter: [2, 'Runs on the JVM, and custom logic is written in Groovy, which Java developers read easily.'],
             k6: [0, ''] },
      python: { locust: [6, 'Tests are plain Python, so your team can reuse its own libraries and skills.'] },
      nocode: { jmeter: [4, 'Tests are built and recorded in a GUI, so testers do not need to write code.'],
                neoload: [3, 'GUI recording with automatic correlation saves a lot of manual scripting.'],
                loadrunner: [2, 'VuGen records scripts and correlates many dynamic values automatically.'] },
      other: { k6: [2, 'Short, readable scripts are quick to pick up whatever language your team uses.'],
               jmeter: [2, 'GUI-based, so no particular programming language is needed.'] }
    },
    proto: {
      http: { k6: [1, ''], jmeter: [1, ''], gatling: [1, ''], locust: [1, ''], artillery: [1, ''] },
      browser: { k6: [3, 'Has a built-in browser module for real-browser tests alongside protocol-level load.'],
                 artillery: [2, 'Runs Playwright scripts as load tests.'],
                 loadrunner: [1, 'TruClient records real-browser scripts.'],
                 jmeter: [-1, ''], gatling: [-1, ''], locust: [-1, ''] },
      grpc: { k6: [3, 'gRPC and WebSockets are built in.'],
              gatling: [2, 'WebSocket support is built in, with gRPC available as a plugin.'],
              artillery: [1, 'WebSocket and Socket.IO are built in.'],
              locust: [1, 'Can drive any protocol that has a Python client, with a little code.'],
              jmeter: [0, ''] },
      legacy: { loadrunner: [12, 'One of the few tools that records and replays SAP GUI, Citrix, Oracle Forms and terminal protocols.'],
                neoload: [10, 'Supports SAP GUI, Citrix and Oracle Forms, with automatic correlation.'],
                k6: [-10, ''], jmeter: [-8, ''], gatling: [-10, ''], locust: [-10, ''], artillery: [-10, ''] },
      backend: { jmeter: [6, 'JDBC, JMS, LDAP, FTP, mail and TCP samplers are built in.'],
                 loadrunner: [2, 'Covers many back-end protocols, at a licence cost.'],
                 gatling: [1, 'Supports JMS out of the box.'],
                 k6: [-2, ''], artillery: [-2, ''], locust: [0, ''] }
    },
    scale: {
      small: {},
      medium: { k6: [1, 'Low resource use per virtual user, so one or two machines go a long way.'],
                gatling: [1, 'Efficient non-blocking engine, so one or two machines go a long way.'] },
      large: { k6: [2, 'Scales out with the k6 Operator on Kubernetes or Grafana Cloud k6.'],
               gatling: [2, 'Efficient engine, with Gatling Enterprise for distributed load.'],
               artillery: [1, 'Can spread a big test across AWS Lambda or Fargate for you.'],
               loadrunner: [1, 'Controller and load generators are built for very large tests.'],
               neoload: [1, 'Controller and load generators are built for very large tests.'],
               locust: [-1, ''], jmeter: [-1, ''] }
    },
    budget: {
      free: { loadrunner: [-6, ''], neoload: [-6, ''],
              k6: [1, 'Free and open source.'], jmeter: [1, 'Free and open source.'], gatling: [1, 'Free and open source.'],
              locust: [1, 'Free and open source.'], artillery: [1, 'Free and open source.'] },
      commercial: { loadrunner: [1, 'Comes with vendor support and training.'], neoload: [1, 'Comes with vendor support and training.'] }
    },
    ci: {
      every: { k6: [3, 'Thresholds set the exit code, so a pipeline fails on its own when targets are missed.'],
               gatling: [2, 'Assertions fail the Maven, Gradle or npm build.'],
               artillery: [2, 'ensure checks fail the run in CI.'],
               locust: [1, 'Runs headless in CI, with a little Python to fail on response-time goals.'],
               loadrunner: [-1, ''], neoload: [0, ''], jmeter: [0, ''] },
      scheduled: {},
      none: {}
    },
    skills: {
      none: {},
      k6: { k6: [3, 'Your team already knows it.'] },
      jmeter: { jmeter: [3, 'Your team already knows it, and has plans you can reuse.'] },
      gatling: { gatling: [3, 'Your team already knows it.'] },
      locust: { locust: [3, 'Your team already knows it.'] },
      loadrunner: { loadrunner: [3, 'Your team already knows it, and may already own licences.'] }
    }
  };

  var QUESTIONS = ['lang', 'proto', 'scale', 'budget', 'ci', 'skills'];

  function pick(answers) {
    answers = answers || {};
    var score = {}, reasons = {};
    ORDER.forEach(function (t) { score[t] = 0; reasons[t] = []; });
    QUESTIONS.forEach(function (q) {
      var rule = RULES[q][answers[q]];
      if (!rule) return;
      Object.keys(rule).forEach(function (t) {
        score[t] += rule[t][0];
        if (rule[t][0] > 0 && rule[t][1] && !reasons[t].some(function (r) { return r[1] === rule[t][1]; })) reasons[t].push([rule[t][0], rule[t][1]]);
      });
    });
    var ranked = ORDER.slice().sort(function (a, b) { return score[b] - score[a] || ORDER.indexOf(a) - ORDER.indexOf(b); });

    var notes = [], noteLinks = [];
    if (answers.proto === 'legacy' && answers.budget === 'free') {
      notes.push('No free tool records SAP GUI, Citrix or Oracle Forms well. LoadRunner has a free Community licence (50 virtual users for most protocols) that is enough to prove the approach before you ask for budget.');
    }
    if (answers.scale === 'large') {
      notes.push('At this scale, consider a hosted service for the load generators: Grafana Cloud k6 for k6, BlazeMeter for JMeter and others, or Gatling Enterprise.');
      noteLinks.push(['/compare/blazemeter-vs-grafana-cloud-k6/', 'BlazeMeter vs Grafana Cloud k6']);
    }
    if (answers.proto === 'browser') {
      notes.push('Real browsers use far more CPU than protocol-level users. Most teams run the bulk of the load at protocol level and add a few browser users to measure what pages feel like.');
    }
    if (answers.skills && answers.skills !== 'none' && ranked[0] !== answers.skills && TOOLS[answers.skills]) {
      notes.push('Your team already knows ' + (TOOLS[answers.skills].short || TOOLS[answers.skills].name) + '. Switching costs time, so move only if the reasons above matter to you.');
    }

    function entry(id) {
      // Strongest reasons first (a stable sort: equal points keep question order).
      var r = reasons[id].map(function (x, i) { return [x[0], i, x[1]]; })
        .sort(function (a, b) { return b[0] - a[0] || a[1] - b[1]; }).slice(0, 4).map(function (x) { return x[2]; });
      if (!r.length) r = ['A reasonable fit for your answers, with no strong reason for or against.'];
      return { id: id, name: TOOLS[id].name, score: score[id], reasons: r, links: TOOLS[id].links.slice() };
    }
    var best = entry(ranked[0]), runnerUp = entry(ranked[1]);
    var pairKey = ORDER.indexOf(best.id) < ORDER.indexOf(runnerUp.id) ? best.id + '|' + runnerUp.id : runnerUp.id + '|' + best.id;
    var compare = PAIRS[pairKey] ? '/compare/' + PAIRS[pairKey] + '/' : null;
    return { best: best, runnerUp: runnerUp, compare: compare, notes: notes, noteLinks: noteLinks, ranking: ranked, scores: score };
  }

  var api = { pick: pick, TOOLS: TOOLS, RULES: RULES, QUESTIONS: QUESTIONS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ToolPicker = api;

  // ------------------------------------------------------------------ browser wiring
  if (typeof document === 'undefined') return;
  var form = document.getElementById('tp-form');
  var out = document.getElementById('tp-result');
  if (!form || !out) return;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function linkList(links) {
    var ul = el('ul', 'tp-links');
    links.forEach(function (l) {
      var li = el('li'), a = el('a', null, l[1] + ' →');
      a.href = l[0];
      if (/^https?:/.test(l[0])) { a.target = '_blank'; a.rel = 'noopener'; }
      li.appendChild(a); ul.appendChild(li);
    });
    return ul;
  }
  function card(label, e, main) {
    var c = el('div', 'tp-card' + (main ? ' tp-main' : ''));
    c.appendChild(el('p', 'eyebrow', label));
    c.appendChild(el('h3', null, e.name));
    var ul = el('ul');
    e.reasons.forEach(function (r) { ul.appendChild(el('li', null, r)); });
    c.appendChild(ul);
    c.appendChild(linkList(e.links));
    return c;
  }

  function answers() {
    var a = {}, missing = [];
    QUESTIONS.forEach(function (q) {
      var c = form.querySelector('input[name="' + q + '"]:checked');
      if (c) a[q] = c.value; else missing.push(q);
    });
    return { a: a, missing: missing };
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var got = answers();
    out.textContent = '';
    if (got.missing.length) {
      var first = form.querySelector('fieldset[data-q="' + got.missing[0] + '"]');
      out.appendChild(el('p', 'tp-warn', 'Answer every question first (' + got.missing.length + ' left).'));
      out.hidden = false;
      if (first) { var f = first.querySelector('input'); if (f) f.focus(); }
      return;
    }
    var r = pick(got.a);
    var grid = el('div', 'tp-grid');
    grid.appendChild(card('Our pick', r.best, true));
    grid.appendChild(card('Runner-up', r.runnerUp, false));
    out.appendChild(el('h2', null, 'Your result'));
    out.appendChild(grid);
    if (r.compare) {
      var p = el('p', 'tp-compare'), a = el('a', null, 'Read the full ' + (TOOLS[r.best.id].short || r.best.name) + ' vs ' + (TOOLS[r.runnerUp.id].short || r.runnerUp.name) + ' comparison →');
      a.href = r.compare; p.appendChild(a); out.appendChild(p);
    }
    if (r.notes.length) {
      var notes = el('div', 'tp-notes');
      r.notes.forEach(function (n) { notes.appendChild(el('p', null, n)); });
      if (r.noteLinks.length) notes.appendChild(linkList(r.noteLinks));
      out.appendChild(notes);
    }
    out.hidden = false;
    out.focus();
    try { window.history.replaceState(null, '', '#' + QUESTIONS.map(function (q) { return q + '=' + got.a[q]; }).join('&')); } catch (e) { /* ignore */ }
  });

  // Restore answers from the URL hash, so a result can be shared.
  (function () {
    var h = (window.location.hash || '').slice(1);
    if (!h || h.indexOf('=') < 0) return;
    var all = true;
    h.split('&').forEach(function (kv) {
      var p = kv.split('=').map(function (x) { return (x || '').replace(/[^a-z0-9]/g, ''); });
      var i = p[0] && p[1] ? form.querySelector('input[name="' + p[0] + '"][value="' + p[1] + '"]') : null;
      if (i) i.checked = true; else all = false;
    });
    if (all && answers().missing.length === 0) form.dispatchEvent(new Event('submit', { cancelable: true }));
  })();
})(typeof window !== 'undefined' ? window : this);
