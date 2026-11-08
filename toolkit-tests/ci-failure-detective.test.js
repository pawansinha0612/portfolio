// Tests for docs/tools/ci-failure-detective/ci.js. Run: node toolkit-tests/ci-failure-detective.test.js
'use strict';
const path = require('path');
const assert = require('assert');
const C = require(path.join(__dirname, '..', 'docs', 'tools', 'ci-failure-detective', 'ci.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
}

// ---------------------------------------------------------------- one real-world line per signature

const SAMPLES = {
  econnreset: 'npm ERR! network read ECONNRESET',
  etimedout: 'npm ERR! network request to https://registry.npmjs.org/x failed, reason: connect ETIMEDOUT 104.16.0.35:443',
  dns: "fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com",
  econnrefused: 'Error: connect ECONNREFUSED 127.0.0.1:5432',
  tls: 'curl: (60) SSL certificate problem: unable to get local issuer certificate',
  ratelimit: 'Error: API rate limit exceeded for installation ID 1234',
  http5xx: 'error An unexpected error occurred: "https://registry.yarnpkg.com/x: 503 Service Unavailable".',
  runnerlost: 'The runner has received a shutdown signal. This can happen when the runner service is stopped',
  eaddrinuse: 'Error: listen EADDRINUSE: address already in use :::3000',
  eresolve: 'npm ERR! code ERESOLVE',
  'npmci-lock': 'npm ERR! `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.',
  'frozen-lock': 'error Your lockfile needs to be updated, but yarn was run with `--frozen-lockfile`.',
  npm404: 'npm ERR! code E404',
  npmauth: 'npm ERR! code E401',
  nodegyp: 'gyp ERR! build error',
  engine: 'error @vitejs/plugin-react@4.3.1: The engine "node" is incompatible with this module. Expected version ">=16.0.0". Got "12.22.12"',
  'pip-nomatch': 'ERROR: No matching distribution found for tensorflow==2.99.0',
  'pip-conflict': 'ERROR: ResolutionImpossible: for help visit https://pip.pypa.io/',
  'maven-deps': '[ERROR] Failed to execute goal on project api: Could not resolve dependencies for project com.acme:api:jar:1.0',
  'gradle-deps': "> Could not resolve all files for configuration ':app:compileClasspath'.",
  'go-mod': 'main.go:5:2: missing go.sum entry for module providing package github.com/x/y',
  'mod-missing': "ModuleNotFoundError: No module named 'requests'",
  composer: 'Your requirements could not be resolved to an installable set of packages.',
  tsc: "src/app.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
  javac: '[ERROR] COMPILATION ERROR : ',
  cs: "Program.cs(10,13): error CS0103: The name 'foo' does not exist in the current context",
  bundler: "Module not found: Error: Can't resolve './Button' in '/home/runner/work/app/src'",
  syntax: 'SyntaxError: Unexpected token }',
  'go-build': './main.go:12:3: undefined: Foo',
  'gradle-task': "Execution failed for task ':app:compileJava'.",
  make: 'make: *** [Makefile:12: build] Error 1',
  webpack: 'webpack compiled with 2 errors',
  'docker-build': 'ERROR: failed to solve: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1',
  nospace: 'write /var/lib/docker/tmp/x: no space left on device',
  oomkilled: 'Killed',
  'java-oom': 'Exception in thread "main" java.lang.OutOfMemoryError: Java heap space',
  'node-oom': 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
  emfile: 'Error: EMFILE: too many open files, watch',
  segfault: 'Segmentation fault (core dumped)',
  publickey: 'git@github.com: Permission denied (publickey).',
  integration: 'Error: Resource not accessible by integration',
  'git-auth': 'remote: Permission to acme/app.git denied to github-actions[bot].',
  http401: 'Error: Request failed with status code 401',
  eacces: './deploy.sh: Permission denied',
  'missing-input': 'Error: Input required and not supplied: token',
  'cloud-auth': 'An error occurred (ExpiredToken) when calling the GetCallerIdentity operation: The security token included in the request is expired',
  toomanyrequests: 'Error response from daemon: toomanyrequests: You have reached your pull rate limit.',
  manifest: 'Error response from daemon: manifest for node:99-alpine not found: manifest unknown: manifest unknown',
  'pull-denied': "Error response from daemon: pull access denied for acme/api, repository does not exist or may require 'docker login'",
  'docker-daemon': 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
  imagepull: 'api-7d9c6b5f4-x2x9z   0/1     ImagePullBackOff   0          2m',
  crashloop: 'api-7d9c6b5f4-x2x9z   0/1     CrashLoopBackOff   5          4m',
  rollout: 'error: deployment "api" exceeded its progress deadline',
  'k8s-conn': 'Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout',
  rbac: 'Error from server (Forbidden): deployments.apps "api" is forbidden: User "ci" cannot patch resource',
  helm: 'Error: UPGRADE FAILED: another operation (install/upgrade/rollback) is in progress',
  terraform: 'Error: Error acquiring the state lock',
  jest: 'Tests:       2 failed, 40 passed, 42 total',
  pytest: 'FAILED tests/test_cart.py::test_total - assert 10 == 11',
  surefire: '[ERROR] Tests run: 12, Failures: 2, Errors: 0, Skipped: 0',
  'gradle-test': 'There were failing tests. See the report at: file:///build/reports/tests/test/index.html',
  assertion: 'AssertionError: expected 200 to equal 201',
  'go-test': '--- FAIL: TestTotal (0.00s)',
  'pw-failed': '  2 failed',
  'dotnet-test': 'Failed!  - Failed:     3, Passed:    40, Skipped:     0, Total:    43',
  cypress: '  2 of 10 failed (20%)',
  'pw-timeout': 'Error: page.click: Timeout 30000ms exceeded.',
  'not-interactable': 'selenium.common.exceptions.ElementNotInteractableException: Message: element not interactable',
  stale: 'org.openqa.selenium.StaleElementReferenceException: stale element reference: element is not attached to the page document',
  nosuchelement: 'org.openqa.selenium.NoSuchElementException: no such element: Unable to locate element',
  intercepted: 'element click intercepted: Element <button> is not clickable at point (1,1). Other element would receive the click',
  'target-closed': 'Error: page.goto: Target page, context or browser has been closed',
  'flaky-marker': '  3 flaky',
  'gh-timeout': 'The job running on runner GitHub Actions 2 has exceeded the maximum execution time of 360 minutes.',
  cancelled: 'Error: The operation was canceled.',
  'gitlab-timeout': 'ERROR: Job failed: execution took longer than 1h0m0s seconds',
  'jenkins-timeout': 'Cancelling nested steps due to timeout',
  'gh-workflow': 'Invalid workflow file: .github/workflows/ci.yml#L12',
  'gitlab-yaml': 'This GitLab CI configuration is invalid: jobs:test config contains unknown keys: scrpt',
  yaml: 'yaml: line 12: mapping values are not allowed in this context',
  jenkinsfile: 'WorkflowScript: 14: Expected a step @ line 14, column 9.',
  'cmd-not-found': '/bin/bash: line 1: pnpm: command not found',
  'action-missing': 'Error: Unable to resolve action `actions/chekout@v4`, repository not found',
  sonar: 'QUALITY GATE STATUS: FAILED - View details on https://sonar.acme.com/dashboard?id=app',
  eslint: '✖ 12 problems (5 errors, 7 warnings)',
  coverage: 'Jest: "global" coverage threshold for lines (80%) not met: 72.5%',
  vulns: 'found 3 high severity vulnerabilities',
  'gh-exit': 'Error: Process completed with exit code 1.',
  'gl-exit': 'ERROR: Job failed: exit code 1',
  'jenkins-fail': 'Finished: FAILURE',
  'build-failed': 'npm ERR! code ELIFECYCLE',
  'npm-log': 'npm ERR! A complete log of this run can be found in:',
  'gh-error': '##[error]Something went wrong',
};

test('signature library: at least 60 signatures, every category used, each has cause and fix', () => {
  assert.ok(C.SIGNATURES.length >= 60, C.SIGNATURES.length + ' signatures');
  const cats = new Set(C.SIGNATURES.map(s => s.cat));
  Object.keys(C.CATS).forEach(c => assert.ok(cats.has(c), 'category ' + c + ' unused'));
  C.SIGNATURES.forEach(s => { assert.ok(s.cause.length > 20 && s.fix.length > 10, s.id); });
  assert.strictEqual(new Set(C.SIGNATURES.map(s => s.id)).size, C.SIGNATURES.length, 'ids unique');
});

test('every signature matches its sample line (and the sample is not claimed by another signature)', () => {
  const bad = [];
  C.SIGNATURES.forEach(s => {
    assert.ok(SAMPLES[s.id], 'no sample for ' + s.id);
    const r = C.analyse(SAMPLES[s.id]);
    if (!r.groups.length || r.groups[0].id !== s.id) bad.push(s.id + ' → ' + (r.groups.map(g => g.id).join(',') || 'none'));
  });
  assert.deepStrictEqual(bad, []);
});

test('ordinary lines do not match anything', () => {
  const r = C.analyse('Run npm test\n> app@1.0.0 test\n> jest\nPASS src/a.test.js\nTests: 0 failed, 3 passed, 3 total\nDone in 3.2s\nErrors: 0\nCompiled successfully');
  assert.deepStrictEqual(r.groups.map(g => g.id), []);
});

// ---------------------------------------------------------------- cleaning and CI detection

test('clean strips ANSI colours, CR progress and timestamp prefixes from each CI', () => {
  const lines = C.clean([
    '2026-11-08T10:00:03.1234567Z \x1b[36;1mnpm ci\x1b[0m',
    '2026-11-08T10:00:00.123456Z 00O $ npm test',
    '2026-11-08T10:00:00.123456Z 01E+npm ERR! code E401',
    '[2026-11-08T10:00:00.123Z] [Pipeline] sh',
    '10:00:01  + make build',
    'Downloading 10%\rDownloading 50%\rDownloading 100%',
    'build\tRun tests\t2026-11-08T10:00:00.0000000Z hello',
  ].join('\r\n'));
  assert.deepStrictEqual(lines, ['npm ci', '$ npm test', 'npm ERR! code E401', '[Pipeline] sh', '+ make build', 'Downloading 100%', 'hello']);
});

test('detectCI recognises GitHub Actions, GitLab, Jenkins and Azure', () => {
  assert.strictEqual(C.detectCI('2026-11-08T10:00:00.0Z ##[group]Run actions/checkout@v4\n##[endgroup]'), 'github');
  assert.strictEqual(C.detectCI('Running with gitlab-runner 17.5.0 (abc)\nsection_start:1731060000:prepare_executor\r\nPreparing the "docker" executor'), 'gitlab');
  assert.strictEqual(C.detectCI('Started by user Pawan\n[Pipeline] Start of Pipeline\n[Pipeline] node\nFinished: FAILURE'), 'jenkins');
  assert.strictEqual(C.detectCI('##[section]Starting: Build\nAgent name: Hosted Agent'), 'azure');
  assert.strictEqual(C.detectCI('hello world'), 'unknown');
});

// ---------------------------------------------------------------- root cause vs noise

const GH_LOG = [
  '2026-11-08T10:00:00.1Z Current runner version: \'2.320.0\'',
  '2026-11-08T10:00:00.2Z ##[group]Run npm ci',
  '2026-11-08T10:00:01.0Z npm ERR! code ENOSPC',
  '2026-11-08T10:00:01.0Z npm ERR! syscall write',
  '2026-11-08T10:00:01.0Z npm ERR! nospc ENOSPC: no space left on device, write',
  '2026-11-08T10:00:01.0Z npm ERR! A complete log of this run can be found in:',
  '2026-11-08T10:00:01.1Z ##[error]Process completed with exit code 228.',
].join('\n');

test('root cause is the real error, not the exit code or npm log pointer that follow it', () => {
  const r = C.analyse(GH_LOG);
  assert.strictEqual(r.ci, 'github');
  assert.strictEqual(r.root.sig.id, 'nospace');
  assert.strictEqual(r.root.line, 3);
  assert.strictEqual(r.exitCode, 228);
  assert.strictEqual(r.status, 'failed');
  const exit = r.matches.find(m => m.sigId === 'gh-exit');
  assert.strictEqual(exit.role, 'follow-on');
  assert.ok(r.root.context.some(c => c.hit && /ENOSPC/.test(c.text)));
  assert.ok(r.root.context.some(c => !c.hit && /no space left/.test(c.text)));
  assert.ok(/Disk full/.test(r.summary));
});

test('a severe infrastructure failure outranks the test failures it caused', () => {
  const log = ['Running 40 tests', '  ✘  1 [chromium] › a.spec.ts:3:5 › home (30.0s)', 'Error: page.goto: Timeout 30000ms exceeded.',
    'Error response from daemon: toomanyrequests: You have reached your pull rate limit.', '  1 failed', '    [chromium] › a.spec.ts:3:5 › home'].join('\n');
  const r = C.analyse(log);
  assert.strictEqual(r.root.sig.id, 'toomanyrequests');
});

test('within a short window, the more specific error wins over an earlier generic-ish one', () => {
  const log = ["> Task :app:compileJava FAILED", "Execution failed for task ':app:compileJava'.", '> java.lang.OutOfMemoryError: Java heap space', 'BUILD FAILED in 12s'].join('\n');
  const r = C.analyse(log);
  assert.strictEqual(r.root.sig.id, 'java-oom');
});

test('unknown errors fall back to the first error-like line; a passing Jenkins job says so', () => {
  const r = C.analyse('step 1\nsomething odd happened: widget error 42\nmore');
  assert.strictEqual(r.root.sig, null);
  assert.strictEqual(r.root.line, 2);
  const ok = C.analyse('Started by user x\n[Pipeline] sh\n+ make\nFinished: SUCCESS');
  assert.strictEqual(ok.status, 'passed');
  assert.strictEqual(ok.root, null);
  assert.ok(/passed/.test(ok.summary));
});

test('exit code meanings', () => {
  const r = C.analyse('ERROR: Job failed: exit code 137');
  assert.strictEqual(r.exitCode, 137);
  assert.ok(/out of memory/.test(r.exitMeaning));
});

// ---------------------------------------------------------------- tests in logs

test('failed tests are listed for Jest, pytest, Maven, Gradle, Go, .NET and RSpec', () => {
  const log = [
    '  ● Cart › adds totals', '  ✓ renders (5 ms)',
    'FAILED tests/test_cart.py::test_total - assert 10 == 11', 'tests/test_cart.py::test_ok PASSED',
    '[ERROR]   CartTest.totals:42 expected:<10> but was:<11>',
    'com.acme.CartTest > addsItem() FAILED', 'com.acme.CartTest > removesItem() PASSED',
    '--- FAIL: TestTotal (0.00s)', '--- PASS: TestOk (0.00s)',
    '  Failed Acme.Tests.CartTests.Total [12 ms]',
    'rspec ./spec/cart_spec.rb:12 # Cart totals',
  ].join('\n');
  const r = C.analyse(log);
  const fails = r.failedTests.map(t => t.framework + ':' + t.name);
  assert.deepStrictEqual(fails, ['jest:adds totals', 'pytest:tests/test_cart.py::test_total', 'junit:CartTest.totals', 'gradle:CartTest.addsItem', 'go:TestTotal', 'dotnet:Acme.Tests.CartTests.Total', 'rspec:Cart totals (./spec/cart_spec.rb:12)']);
  assert.ok(r.tests.some(t => t.status === 'pass' && t.name === 'TestOk'));
});

test('Playwright: failed, passed and passed-on-retry (flaky) tests', () => {
  const log = [
    'Running 4 tests using 2 workers',
    '  ✓  1 [chromium] › tests/home.spec.ts:3:5 › has title (1.2s)',
    '  ✘  2 [chromium] › tests/home.spec.ts:8:5 › get started link (30.0s)',
    '  ✘  3 [chromium] › tests/cart.spec.ts:5:5 › add to cart (5.0s)',
    '  ✓  4 [chromium] › tests/cart.spec.ts:5:5 › add to cart (retry #1) (2.0s)',
    '', '  1) [chromium] › tests/home.spec.ts:8:5 › get started link ────────', '',
    '    Error: locator.click: Timeout 30000ms exceeded.', '',
    '  1 failed', '    [chromium] › tests/home.spec.ts:8:5 › get started link',
    '  1 flaky', '    [chromium] › tests/cart.spec.ts:5:5 › add to cart', '  2 passed (35.2s)',
  ].join('\n');
  const r = C.analyse(log);
  assert.deepStrictEqual(r.failedTests.map(t => t.name), ['tests/home.spec.ts:8:5 › get started link [chromium]']);
  assert.deepStrictEqual(r.flakyTests.map(t => t.name), ['tests/cart.spec.ts:5:5 › add to cart [chromium]']);
  assert.strictEqual(r.root.sig.id, 'pw-timeout');
});

// ---------------------------------------------------------------- JUnit XML

const XML = (failTotals, extra) => `<?xml version="1.0" encoding="UTF-8"?>
<!-- generated -->
<testsuites>
  <testsuite name="CartTest" tests="4" failures="1">
    <testcase classname="com.acme.CartTest" name="addsItem" time="0.10"/>
    <testcase classname="com.acme.CartTest" name="totals" time="0.20">${failTotals ? '<failure message="expected &lt;10&gt; but was &lt;11&gt;" type="org.opentest4j.AssertionFailedError"><![CDATA[at com.acme.CartTest.totals(CartTest.java:20) <x>]]></failure>' : ''}</testcase>
    <testcase classname="com.acme.CartTest" name="skipped"><skipped message="later"/></testcase>
    <testcase classname="com.acme.CartTest" name="checkout" time="1.5">${extra || ''}</testcase>
  </testsuite>
</testsuites>`;

test('JUnit XML is parsed without DOMParser: statuses, messages, entities and CDATA', () => {
  const j = C.parseJUnitXML(XML(true, '<flakyFailure message="Timeout"/>'));
  assert.strictEqual(j.total, 4);
  assert.strictEqual(j.failed, 1);
  assert.strictEqual(j.skipped, 1);
  assert.strictEqual(j.flaky, 1);
  const t = j.cases.find(c => c.name === 'totals');
  assert.strictEqual(t.status, 'fail');
  assert.strictEqual(t.message, 'expected <10> but was <11>');
  assert.strictEqual(t.type, 'org.opentest4j.AssertionFailedError');
  assert.ok(/CartTest\.java:20\) <x>/.test(t.detail));
  assert.strictEqual(j.cases[0].suite, 'CartTest');
  assert.throws(() => C.parseJUnitXML('<html></html>'), /JUnit/);
  // a suite with an error element and single-quoted attributes
  const e = C.parseJUnitXML("<testsuite name='s'><testcase name='a' classname='X'><error message='boom'/></testcase></testsuite>");
  assert.strictEqual(e.cases[0].status, 'error');
  assert.strictEqual(e.failed, 1);
});

// ---------------------------------------------------------------- multi-run

test('multi-run: per-test history, flaky detection, recurring failures and category trend', () => {
  const runs = [
    { name: 'run 1', text: XML(true) },
    { name: 'run 2', text: XML(false) },
    { name: 'run 3', text: XML(true, '<failure message="Timeout 30000ms exceeded"/>') },
    { name: 'run 4 log', text: 'npm ERR! code ERESOLVE\n--- FAIL: TestX (0.1s)\nError: Process completed with exit code 1.' },
  ];
  const m = C.multiRun(runs);
  assert.strictEqual(m.runCount, 4);
  assert.deepStrictEqual(m.runs.map(r => r.kind), ['junit', 'junit', 'junit', 'log']);
  const totals = m.tests.find(t => t.name === 'CartTest.totals');
  assert.deepStrictEqual(totals.statuses, ['fail', 'pass', 'fail', null]);
  assert.ok(totals.flaky);
  assert.strictEqual(totals.flips, 2);
  // pass, pass, fail: a new break, not flakiness
  const checkout = m.tests.find(t => t.name === 'CartTest.checkout');
  assert.ok(!checkout.flaky);
  assert.strictEqual(checkout.brokenSince, 2);
  // fail then pass once: fixed, not flaky
  const fixed = C.multiRun([{ name: 'a', text: XML(true) }, { name: 'b', text: XML(false) }]).tests.find(t => t.name === 'CartTest.totals');
  assert.ok(!fixed.flaky);
  assert.strictEqual(fixed.fixedIn, 1);
  assert.deepStrictEqual(m.recurring.map(t => t.name).slice(0, 1), ['CartTest.totals']);
  assert.ok(m.tests.find(t => t.name === 'TestX').alwaysFails);
  assert.strictEqual(m.runs[3].root.title, 'npm could not resolve peer dependencies (ERESOLVE)');
  assert.ok(m.categories.indexOf('deps') >= 0);
  assert.strictEqual(m.trend.length, 4);
  const md = C.multiToMarkdown(m);
  assert.ok(/Flaky tests/.test(md) && /CartTest\.totals/.test(md) && /❌ ✅ ❌/.test(md));
});

test('a test retried inside one JUnit file (flakyFailure) counts as flaky for that run', () => {
  const m = C.multiRun([{ name: 'a', text: XML(false, '<flakyFailure message="x"/>') }]);
  assert.deepStrictEqual(m.tests.find(t => t.name === 'CartTest.checkout').statuses, ['flaky']);
  assert.strictEqual(m.flaky.length, 1);
});

// ---------------------------------------------------------------- export and speed

test('Markdown summary for a ticket', () => {
  const md = C.toMarkdown(C.analyse(GH_LOG), 'build #42');
  assert.ok(/^### CI failure summary: build #42/.test(md));
  assert.ok(/Root cause candidate \(line 3\):\*\* Disk full/.test(md));
  assert.ok(/\*\*Fix:\*\*/.test(md));
});

test('a 10 MB log is analysed quickly', () => {
  const parts = [];
  for (let i = 0; i < 120000; i++) parts.push('2026-11-08T10:00:00.0000000Z [INFO] compiling module ' + i + ' of 120000 with some ordinary output text here');
  parts.splice(90000, 0, '2026-11-08T10:00:00.0Z npm ERR! code ERESOLVE');
  const text = parts.join('\n');
  const t0 = Date.now();
  const r = C.analyse(text);
  const ms = Date.now() - t0;
  assert.strictEqual(r.root.sig.id, 'eresolve');
  assert.ok(ms < 4000, 'took ' + ms + ' ms');
  console.log('       (' + (text.length / 1e6).toFixed(1) + ' MB in ' + ms + ' ms)');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
