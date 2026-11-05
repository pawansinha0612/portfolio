#!/usr/bin/env node
/* to-k6: convert JMeter, Postman, OpenAPI/Swagger and curl into k6 scripts from the command line.
   Same converters as https://pawansinha.com.au/tools/ (copied into lib/ at pack time). Runs offline. */
'use strict';
const fs = require('fs');
const path = require('path');

const VERSION = require('../package.json').version;
const KINDS = ['jmeter', 'postman', 'openapi', 'curl'];
const ALIASES = { jmx: 'jmeter', swagger: 'openapi', oas: 'openapi', postman: 'postman', collection: 'postman' };

const HELP = `to-k6 ${VERSION}: convert load tests and API definitions into k6 scripts (runs offline)

Usage
  to-k6 [type] <file|-> [options] > script.js

Types (optional: guessed from the file when left out)
  jmeter    JMeter test plan (.jmx)
  postman   Postman collection v2.0 / v2.1 (.json)
  openapi   OpenAPI 3.x or Swagger 2.0 (.json, .yaml)
  curl      One or more curl commands (bash or Windows cmd, e.g. Chrome "Copy as cURL")

Options
  -o, --out <file>        write the script to a file instead of stdout
  --p95 <ms>              p95 response-time threshold (default 500, 0 = none)
  --error-rate <percent>  failed-request threshold (default 1)
  --vus <n>               virtual users (postman, openapi, curl; default 10)
  --duration <d>          test duration, e.g. 30s, 5m (default 1m; jmeter 10m when unset in the plan)
  --env <file>            Postman environment file (postman only)
  --base-url <url>        override the server URL (openapi only)
  -q, --quiet             don't print notes and TODOs
  -h, --help              show this help
  -v, --version           show the version

Examples
  npx to-k6 plan.jmx > script.js
  npx to-k6 postman collection.json --env dev.postman_environment.json -o script.js
  npx to-k6 openapi.yaml --vus 20 --duration 5m > script.js
  pbpaste | npx to-k6 curl - > script.js
  k6 run script.js

Notes and TODOs (things that need a human) go to stderr, so they don't end up in the script.
Online versions and the free migration guide: https://pawansinha.com.au/tools/
Need a whole JMeter suite moved or a load test run for you? https://pawansinha.com.au/services/`;

function fail(msg, code) { process.stderr.write('to-k6: ' + msg + '\n'); process.exit(code == null ? 1 : code); }

function parseArgs(argv) {
  const a = { positional: [], opts: {} };
  const needsValue = new Set(['-o', '--out', '--p95', '--error-rate', '--vus', '--duration', '--env', '--base-url']);
  for (let i = 0; i < argv.length; i++) {
    let t = argv[i];
    let val;
    if (t.startsWith('--') && t.includes('=')) { val = t.slice(t.indexOf('=') + 1); t = t.slice(0, t.indexOf('=')); }
    if (t === '-h' || t === '--help') a.opts.help = true;
    else if (t === '-v' || t === '--version') a.opts.version = true;
    else if (t === '-q' || t === '--quiet') a.opts.quiet = true;
    else if (needsValue.has(t)) {
      if (val === undefined) { val = argv[++i]; if (val === undefined) fail(t + ' needs a value. Run to-k6 --help.'); }
      a.opts[t === '-o' ? 'out' : t.replace(/^--/, '')] = val;
    } else if (t.startsWith('-') && t !== '-') fail('unknown option ' + t + '. Run to-k6 --help.');
    else a.positional.push(t);
  }
  return a;
}

function guessKind(file, text) {
  const ext = path.extname(file || '').toLowerCase();
  const s = text.replace(/^﻿/, '').trimStart();
  if (ext === '.jmx' || /<jmeterTestPlan[\s>]/.test(s.slice(0, 2000))) return 'jmeter';
  if (/^curl(\.exe)?\s/i.test(s)) return 'curl';
  if (/^\s*(openapi|swagger)\s*:/m.test(s.slice(0, 4000))) return 'openapi';
  if (s[0] === '{') {
    try {
      const j = JSON.parse(s);
      if (j.openapi || j.swagger) return 'openapi';
      if ((j.info && j.item) || (j.collection && j.collection.item)) return 'postman';
    } catch (e) { /* fall through */ }
  }
  if (ext === '.yaml' || ext === '.yml') return 'openapi';
  return null;
}

function num(v, name) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) fail(name + ' must be a number, got "' + v + '"');
  return n;
}

function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  if (opts.version) { process.stdout.write(VERSION + '\n'); return; }
  if (opts.help || !positional.length) { process.stdout.write(HELP + '\n'); if (!opts.help) process.exitCode = 1; return; }

  let kind = null;
  let file = positional[0];
  const first = (ALIASES[positional[0]] || positional[0]).toLowerCase();
  if (KINDS.includes(first) && positional.length > 1) { kind = first; file = positional[1]; }
  else if (positional.length > 1) fail('expected one file, got: ' + positional.join(' ') + '. Run to-k6 --help.');

  let text;
  try { text = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8'); }
  catch (e) { fail('can\'t read ' + (file === '-' ? 'stdin' : file) + ': ' + e.message); }
  if (!kind) kind = guessKind(file === '-' ? '' : file, text);
  if (!kind) fail('can\'t tell what kind of file this is. Say it first: to-k6 jmeter|postman|openapi|curl <file>');

  const conv = require('../lib/' + kind + '.js');
  const o = {};
  const p95 = num(opts.p95, '--p95'); if (p95 !== undefined) o.p95 = p95;
  const er = num(opts['error-rate'], '--error-rate'); if (er !== undefined) o.errorRate = er;
  if (opts.duration) o.duration = opts.duration;
  if (opts.vus !== undefined) { if (kind === 'jmeter') process.stderr.write('to-k6: --vus is ignored for JMeter (thread groups set the users)\n'); else o.vus = num(opts.vus, '--vus'); }
  if (opts['base-url']) { if (kind === 'openapi') o.baseUrl = opts['base-url']; else process.stderr.write('to-k6: --base-url only applies to openapi, ignored\n'); }
  if (opts.env && kind !== 'postman') process.stderr.write('to-k6: --env only applies to postman, ignored\n');

  let r;
  if (kind === 'postman') {
    let env = null;
    if (opts.env) { try { env = fs.readFileSync(opts.env, 'utf8'); } catch (e) { fail('can\'t read ' + opts.env + ': ' + e.message); } }
    r = conv.convert(text, env, o);
  } else if (kind === 'openapi') {
    o.yaml = s => require('js-yaml').load(s);
    r = conv.convert(text, o);
  } else r = conv.convert(text, o);

  if (r.error) fail(r.error);
  if (!r.script) fail('nothing to convert.');

  if (!opts.quiet) {
    const notes = [].concat(r.warnings || []).map(w => '  ! ' + w)
      .concat([].concat(r.infos || r.info || []).map(i => '  - ' + i));
    const env = (r.env || []).map(e => typeof e === 'string' ? e : (e.name || e.key || JSON.stringify(e)));
    if (notes.length) process.stderr.write('to-k6 (' + kind + ') notes:\n' + notes.join('\n') + '\n');
    if (env.length) process.stderr.write('Environment variables the script reads (k6 run -e NAME=value):\n  ' + env.join(', ') + '\n');
    const todos = (r.script.match(/TODO/g) || []).length;
    if (todos) process.stderr.write(todos + ' TODO' + (todos > 1 ? 's' : '') + ' marked in the script: search for "TODO".\n');
  }

  const out = r.script.endsWith('\n') ? r.script : r.script + '\n';
  if (opts.out) {
    try { fs.writeFileSync(opts.out, out); } catch (e) { fail('can\'t write ' + opts.out + ': ' + e.message); }
    if (!opts.quiet) process.stderr.write('Wrote ' + opts.out + '. Check it with: k6 inspect ' + opts.out + '\n');
  } else process.stdout.write(out);
}

main();
