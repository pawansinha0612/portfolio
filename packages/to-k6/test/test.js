// Runs the CLI on the website's own examples (one per converter) and, when k6 is installed, checks each script
// with `k6 inspect`. Run: npm test (from packages/to-k6).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const assert = require('assert');

const root = path.join(__dirname, '..');
const cli = path.join(root, 'bin', 'to-k6.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'to-k6-'));
const site = path.join(root, '..', '..', 'docs', 'tools');

function asText(v) { return typeof v === 'string' ? v : JSON.stringify(v); }
const jmxPage = fs.readFileSync(path.join(site, 'jmeter-to-k6', 'index.html'), 'utf8');
const jmx = jmxPage.match(/<script type="text\/plain" id="example-jmx">([\s\S]*?)<\/script>/)[1].trim();
const curl = require('../lib/curl.js');
const postman = require('../lib/postman.js');
const openapi = require('../lib/openapi.js');

const files = {
  'plan.jmx': jmx,
  'commands.sh': asText(curl.EXAMPLES.chrome),
  'collection.json': asText(postman.EXAMPLES.api),
  'env.json': asText(postman.ENV_EXAMPLE),
  'openapi.yaml': asText(openapi.EXAMPLES.openapi3),
  'swagger.txt': asText(openapi.EXAMPLES.swagger2),
};
for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(tmp, n), t);
// The example JMeter plan reads a CSV Data Set; k6 inspect opens it, so give it one.
fs.writeFileSync(path.join(tmp, 'users.csv'), 'username,password\nuser1,secret1\n');
fs.mkdirSync(path.join(tmp, 'data'));
fs.writeFileSync(path.join(tmp, 'data', 'users.csv'), 'username,password\nuser1,secret1\n');

const run = (args, input) => spawnSync(process.execPath, [cli].concat(args), { cwd: tmp, input, encoding: 'utf8' });
const k6 = spawnSync('k6', ['version'], { encoding: 'utf8' }).status === 0;
let n = 0;

function ok(name, args, input, expectKind) {
  const r = run(args, input);
  assert.strictEqual(r.status, 0, name + ' exited ' + r.status + ': ' + r.stderr);
  assert.ok(/export (default )?function|export const options/.test(r.stdout), name + ': no k6 script on stdout');
  assert.ok(!/to-k6 .*notes/.test(r.stdout), name + ': notes leaked into stdout');
  if (expectKind) assert.ok(r.stderr.includes('(' + expectKind + ')') || !r.stderr.includes('notes:'), name + ': wrong converter');
  const out = path.join(tmp, name.replace(/\W+/g, '_') + '.js');
  fs.writeFileSync(out, r.stdout);
  if (k6) {
    const i = spawnSync('k6', ['inspect', out], { encoding: 'utf8' });
    assert.strictEqual(i.status, 0, name + ': k6 inspect failed: ' + i.stderr.slice(0, 500));
  }
  n++;
  return r;
}

ok('jmeter auto-detect', ['plan.jmx']);
ok('jmeter explicit', ['jmeter', 'plan.jmx', '--p95', '800']);
ok('curl auto-detect', ['commands.sh']);
ok('curl stdin', ['curl', '-'], files['commands.sh']);
ok('postman with env', ['postman', 'collection.json', '--env', 'env.json', '--vus', '5', '--duration', '30s']);
ok('postman auto-detect', ['collection.json', '-q']);
ok('openapi yaml', ['openapi.yaml', '--base-url', 'https://api.example.com']);
ok('swagger explicit', ['swagger', 'swagger.txt']);

const p95 = run(['jmeter', 'plan.jmx', '--p95', '777']);
assert.ok(p95.stdout.includes('777'), '--p95 not applied');
n++;

const o = run(['plan.jmx', '-o', 'out.js']);
assert.strictEqual(o.status, 0); assert.ok(fs.existsSync(path.join(tmp, 'out.js'))); assert.strictEqual(o.stdout, ''); n++;

assert.strictEqual(run(['--version']).stdout.trim(), require('../package.json').version); n++;
assert.strictEqual(run(['--help']).status, 0); n++;
assert.notStrictEqual(run(['missing.jmx']).status, 0); n++;
fs.writeFileSync(path.join(tmp, 'junk.txt'), 'hello');
assert.notStrictEqual(run(['junk.txt']).status, 0); n++;
assert.notStrictEqual(run(['jmeter', 'collection.json']).status, 0); n++;
assert.notStrictEqual(run(['plan.jmx', '--bogus']).status, 0); n++;

fs.rmSync(tmp, { recursive: true, force: true });
console.log('to-k6: ' + n + ' tests passed' + (k6 ? ' (scripts checked with k6 inspect)' : ' (k6 not installed: k6 inspect skipped)'));
