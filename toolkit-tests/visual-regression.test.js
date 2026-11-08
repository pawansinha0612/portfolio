// Tests for docs/tools/visual-regression/vr.js. Run: node toolkit-tests/visual-regression.test.js
// The pixel diff, pairing, report and CI generator are tested with in-memory fixtures.
// If @playwright/test and @types/node are on NODE_PATH, the generated config and spec are type-checked with TypeScript
// and run for real with Playwright against a small local page: create baselines, pass unchanged, fail on a change.
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { execFileSync, spawn } = require('child_process');
const VR = require(path.join(__dirname, '..', 'docs', 'tools', 'visual-regression', 'vr.js'));

let passed = 0, failed = 0, skipped = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

// ---------------------------------------------------------------- image helpers
function img(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(fill || [255, 255, 255, 255], i * 4);
  return { width: w, height: h, data };
}
const set = (im, x, y, c) => im.data.set(c, (y * im.width + x) * 4);
const clone = im => ({ width: im.width, height: im.height, data: new Uint8ClampedArray(im.data) });

// ---------------------------------------------------------------- pixel diff
test('identical images: no change, verdict "same"', () => {
  const a = img(40, 30);
  const r = VR.diffImages(a, clone(a));
  assert.strictEqual(r.diffPixels, 0);
  assert.strictEqual(r.changePct, 0);
  assert.strictEqual(r.bbox, null);
  assert.strictEqual(VR.verdict(r, 0.1), 'same');
  assert.strictEqual(r.output.length, 40 * 30 * 4);
});

test('a changed block is counted, boxed and drawn red', () => {
  const a = img(100, 100), b = clone(a);
  for (let x = 10; x < 20; x++) for (let y = 30; y < 35; y++) set(b, x, y, [0, 0, 0, 255]);
  const r = VR.diffImages(a, b);
  assert.strictEqual(r.diffPixels, 50);
  assert.strictEqual(r.changePct, 0.5);
  assert.deepStrictEqual(r.bbox, { x: 10, y: 30, w: 10, h: 5 });
  const p = (32 * 100 + 12) * 4;
  assert.deepStrictEqual([...r.output.slice(p, p + 3)], [230, 30, 50]);
  assert.strictEqual(VR.verdict(r, 0.1), 'fail');
  assert.strictEqual(VR.verdict(r, 1), 'pass');
});

test('colour tolerance: a tiny shade change passes at 0.1, fails at 0', () => {
  const a = img(10, 10, [200, 200, 200, 255]), b = clone(a);
  set(b, 5, 5, [203, 201, 200, 255]);
  assert.strictEqual(VR.diffImages(a, b, { threshold: 0.1 }).diffPixels, 0);
  assert.strictEqual(VR.diffImages(a, b, { threshold: 0 }).diffPixels, 1);
});

test('colour tolerance 0.2 (Playwright default) misses a blue → green button of similar brightness; 0.1 catches it', () => {
  const a = img(4, 4, [37, 87, 214, 255]), b = img(4, 4, [15, 138, 95, 255]);
  assert.strictEqual(VR.diffImages(a, b, { threshold: 0.2 }).diffPixels, 0);
  assert.strictEqual(VR.diffImages(a, b, { threshold: 0.1 }).diffPixels, 16);
  assert.ok(VR.generateCI({}).config.includes('threshold: 0.1,'), 'the generator uses the stricter tolerance');
});

test('YIQ delta: brightness matters more than hue; transparency is flattened onto white', () => {
  const d = (c1, c2) => Math.abs(VR.colorDelta(new Uint8ClampedArray(c1), new Uint8ClampedArray(c2), 0, 0));
  const bw = d([0, 0, 0, 255], [255, 255, 255, 255]);
  assert.ok(bw > 30000 && bw <= VR.MAX_DELTA, 'black vs white is near the maximum');
  assert.ok(d([128, 128, 128, 255], [140, 140, 140, 255]) > d([128, 128, 128, 255], [128, 128, 140, 255]), 'a brightness step outweighs the same step in blue');
  assert.strictEqual(d([10, 20, 30, 0], [255, 255, 255, 255]), 0, 'fully transparent = white');
});

test('anti-aliased edge pixels are skipped (yellow) unless includeAA', () => {
  const a = img(5, 5), b = clone(a);
  for (const im of [a, b]) for (let y = 0; y < 5; y++) { set(im, 0, y, [0, 0, 0, 255]); set(im, 1, y, [0, 0, 0, 255]); set(im, 2, y, [128, 128, 128, 255]); }
  set(b, 2, 2, [90, 90, 90, 255]);
  const r = VR.diffImages(a, b, { threshold: 0.05 });
  assert.strictEqual(r.diffPixels, 0);
  assert.strictEqual(r.aaPixels, 1);
  const p = (2 * 5 + 2) * 4;
  assert.deepStrictEqual([...r.output.slice(p, p + 3)], [250, 200, 0]);
  assert.strictEqual(VR.diffImages(a, b, { threshold: 0.05, includeAA: true }).diffPixels, 1);
});

test('ignore regions are skipped and not counted; reversed rectangles work', () => {
  const a = img(50, 50), b = clone(a);
  for (let x = 0; x < 10; x++) for (let y = 0; y < 10; y++) set(b, x, y, [0, 0, 0, 255]);
  set(b, 40, 40, [0, 0, 0, 255]);
  const r = VR.diffImages(a, b, { ignore: [{ x: 10, y: 10, w: -10, h: -10 }] });
  assert.strictEqual(r.diffPixels, 1);
  assert.strictEqual(r.ignoredPixels, 100);
  assert.strictEqual(r.comparedPixels, 2400);
  assert.deepStrictEqual(r.bbox, { x: 40, y: 40, w: 1, h: 1 });
});

test('different sizes: pad counts the extra area, crop compares the overlap', () => {
  const a = img(20, 10), b = img(20, 12);
  const p = VR.diffImages(a, b);
  assert.ok(p.sizeMismatch);
  assert.strictEqual(p.width, 20); assert.strictEqual(p.height, 12);
  assert.strictEqual(p.diffPixels, 40);
  assert.strictEqual(p.outsidePixels, 40);
  const c = VR.diffImages(a, b, { sizeMode: 'crop' });
  assert.strictEqual(c.height, 10);
  assert.strictEqual(c.diffPixels, 0);
  assert.ok(c.sizeMismatch);
});

test('a 1920×4000 full-page diff runs in reasonable time', () => {
  const a = img(1920, 4000), b = clone(a);
  for (let x = 100; x < 400; x++) set(b, x, 2000, [0, 0, 0, 255]);
  const t0 = Date.now();
  const r = VR.diffImages(a, b);
  assert.strictEqual(r.diffPixels, 300);
  assert.ok(Date.now() - t0 < 4000, 'took ' + (Date.now() - t0) + 'ms');
});

// ---------------------------------------------------------------- pairing
test('pairing by folder path, then by unique file name; suffixes ignored', () => {
  const base = [{ path: 'baseline/home/desktop.png', fromFolder: true }, { path: 'baseline/home/mobile.png', fromFolder: true }, { path: 'baseline/about/desktop.png', fromFolder: true },
    { name: 'checkout-expected.png' }, { name: 'gone.png' }];
  const next = [{ path: 'new/home/desktop.png', fromFolder: true }, { path: 'new/about/desktop.png', fromFolder: true }, { path: 'new/home/mobile.png', fromFolder: true },
    { name: 'checkout-actual.png' }, { name: 'brand-new.png' }];
  const r = VR.pairFiles(base, next);
  assert.deepStrictEqual(r.pairs.map(p => p.key), ['about/desktop.png', 'checkout.png', 'home/desktop.png', 'home/mobile.png']);
  assert.strictEqual(r.pairs.find(p => p.key === 'about/desktop.png').base.path, 'baseline/about/desktop.png');
  assert.deepStrictEqual(r.onlyBase.map(f => f.name), ['gone.png']);
  assert.deepStrictEqual(r.onlyNew.map(f => f.name), ['brand-new.png']);
  // a bare name that matches two baseline files is ambiguous and not guessed
  const amb = VR.pairFiles([{ path: 'b/a/x.png', fromFolder: true }, { path: 'b/c/x.png', fromFolder: true }], [{ name: 'x.png' }]);
  assert.strictEqual(amb.pairs.length, 0);
});

// ---------------------------------------------------------------- report
test('HTML report: counts, escaping, only data-URL images', () => {
  const html = VR.reportHTML({ date: 'now', maxPct: 0.1, threshold: 0.1, onlyBase: ['<gone>.png'], onlyNew: [],
    items: [{ name: '<script>alert(1)</script>.png', status: 'fail', changePct: 1.5, diffPixels: 1500, baseThumb: 'data:image/png;base64,AAAA', newThumb: 'javascript:alert(1)', diffThumb: '' }] });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('javascript:'));
  assert.ok(html.includes('src="data:image/png;base64,AAAA"'));
  assert.ok(html.includes('1.500% of pixels changed'));
  assert.ok(html.includes('&lt;gone&gt;.png'));
});

// ---------------------------------------------------------------- CI generator
test('page list parsing: paths, names, full URLs, duplicates', () => {
  const p = VR.parsePages('/\nPricing | /pricing\nproducts/sun-hat\n# comment\nhttps://other.example.com/x\n/pricing');
  assert.deepStrictEqual(p, [{ name: 'home', path: '/' }, { name: 'pricing', path: '/pricing' }, { name: 'products-sun-hat', path: '/products/sun-hat' },
    { name: 'x', path: 'https://other.example.com/x' }, { name: 'pricing-2', path: '/pricing' }]);
});

test('generated config, spec, workflow and package.json', () => {
  const g = VR.generateCI({ baseURL: 'https://shop.example.com/', pages: "/\nIt's | /it's", viewports: ['mobile', 'desktop'], browsers: ['chromium', 'webkit'], maxDiffPixelRatio: 0.02, masks: '.clock', hideSelectors: '#cookie' });
  assert.strictEqual(g.screenshots, 8);
  assert.ok(g.config.includes("baseURL: process.env.BASE_URL || 'https://shop.example.com'"));
  assert.ok(g.config.includes('maxDiffPixelRatio: 0.02'));
  assert.ok(g.config.includes("{ name: 'webkit', use: { ...devices['Desktop Safari'] } }"));
  assert.ok(g.spec.includes("{ name: 'it-s', path: '/it\\'s' }"), 'quotes escaped');
  assert.ok(g.spec.includes("const masks: string[] = ['.clock'];"));
  assert.ok(g.spec.includes("'#cookie { visibility: hidden !important; }'"));
  assert.ok(g.workflow.includes('npx playwright install --with-deps chromium webkit'));
  assert.ok(g.workflow.includes('npx playwright test --update-snapshots'));
  assert.ok(g.workflow.includes('uses: actions/upload-artifact@v4'));
  assert.ok(/if: \$\{\{ !inputs\.update \}\}/.test(g.workflow));
  assert.ok(g.workflow.includes("vars.BASE_URL || 'https://shop.example.com'"));
  assert.ok(!/\t/.test(g.workflow), 'YAML has no tabs');
  assert.deepStrictEqual(JSON.parse(g.pkg).devDependencies, { '@playwright/test': '^1.48.0' });
  assert.throws(() => VR.generateCI({ baseURL: 'ftp://x' }), /http/);
  assert.throws(() => VR.generateCI({ pages: '' }), /page/);
  assert.throws(() => VR.generateCI({ viewports: [] }), /screen size/);
});

test('generated workflow is valid YAML (if js-yaml is available)', () => {
  let yaml;
  try { yaml = require('js-yaml'); } catch (e) { return 'skip'; }
  const w = yaml.load(VR.generateCI({}).workflow);
  assert.strictEqual(w.name, 'Visual regression');
  assert.ok(w.on.workflow_dispatch.inputs.update);
  assert.strictEqual(w.jobs.visual.steps.length, 6);
});

// ---------------------------------------------------------------- compile and run with the real Playwright
const NM = (process.env.NODE_PATH || '').split(path.delimiter).find(p => p && fs.existsSync(path.join(p, '@playwright', 'test')) && fs.existsSync(path.join(p, '@types', 'node')));

function project(dir, g) {
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'playwright.config.ts'), g.config);
  fs.writeFileSync(path.join(dir, 'tests', 'visual.spec.ts'), g.spec);
  fs.symlinkSync(NM, path.join(dir, 'node_modules'), 'dir');
}

test('generated playwright.config.ts and visual.spec.ts compile (tsc --noEmit, strict, real types)', () => {
  if (!NM) return 'skip';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-tsc-'));
  try {
    project(dir, VR.generateCI({ browsers: ['chromium', 'firefox'], viewports: ['mobile', 'tablet', 'desktop', 'wide'], masks: '.a\n[data-x="y"]', hideSelectors: '#c' }));
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2020', module: 'commonjs',
      lib: ['ES2020', 'DOM'], types: ['node'], skipLibCheck: true }, files: ['tests/visual.spec.ts', 'playwright.config.ts'] }));
    let cmd = ['npx', ['-y', '-p', 'typescript@5.6.3', 'tsc', '-p', dir]];
    try { execFileSync('tsc', ['--version'], { stdio: 'ignore' }); cmd = ['tsc', ['-p', dir]]; } catch (e) { /* use npx */ }
    try { execFileSync(cmd[0], cmd[1], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 }); }
    catch (e) {
      if (!e.stdout && /ENOTFOUND|EAI_AGAIN|network/i.test(String(e.stderr))) return 'skip';
      throw new Error('tsc failed:\n' + (e.stdout || e.stderr));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// A small site: the clock is masked and the cookie banner hidden, so they change on every load without failing the test.
const SITE = `
const http = require('http');
let changed = false;
http.createServer((req, res) => {
  if (req.url === '/__change') { changed = true; res.end('ok'); return; }
  const page = req.url.startsWith('/about') ? 'About us' : 'Summer sale';
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><html><head><style>body{font-family:sans-serif;margin:0}header{background:#1f2a44;color:#fff;padding:16px}'
    + 'button{background:' + (changed ? '#0f8a5f' : '#2557d6') + ';color:#fff;border:0;padding:12px 20px;border-radius:8px;font-size:16px}'
    + '#cookie-banner{position:fixed;bottom:0;left:0;right:0;background:#fffbe6;padding:12px}</style></head><body>'
    + '<header>Acme</header><main style="padding:24px"><h1>' + page + '</h1><p>Free delivery over $50.</p><button>Shop now</button>'
    + '<p data-testid="last-updated">Updated ' + Date.now() + '</p></main><div id="cookie-banner">Cookies ' + Math.random() + '</div></body></html>');
}).listen(+process.argv[1], '127.0.0.1', () => console.log('ready'));`;

test('the generated suite runs with the real Playwright: baselines created, unchanged passes, a change fails', async () => {
  if (!NM) return 'skip';
  const port = 8813;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-run-'));
  const server = spawn(process.execPath, ['-e', SITE, String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  const pw = args => new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(NM, '@playwright', 'test', 'cli.js'), 'test', ...args], { cwd: dir, env: Object.assign({}, process.env, { CI: '1' }) });
    let text = ''; p.stdout.on('data', d => { text += d; }); p.stderr.on('data', d => { text += d; });
    p.on('exit', code => resolve({ code, text }));
  });
  try {
    await new Promise((resolve, reject) => {
      server.stdout.on('data', d => { if (/ready/.test(d)) resolve(); });
      server.on('exit', c => reject(new Error('site exited with ' + c)));
      setTimeout(() => reject(new Error('site did not start')), 5000);
    });
    project(dir, VR.generateCI({ baseURL: 'http://127.0.0.1:' + port, pages: '/\n/about', viewports: ['mobile', 'desktop'], browsers: ['chromium'],
      maxDiffPixelRatio: 0, masks: '[data-testid="last-updated"]', hideSelectors: '#cookie-banner', waitUntil: 'load' }));
    const first = await pw(['--update-snapshots']);
    if (first.code !== 0 && /Executable doesn't exist|browserType\.launch/.test(first.text)) return 'skip';
    assert.strictEqual(first.code, 0, 'baseline run failed:\n' + first.text.slice(-2500));
    const shots = fs.readdirSync(path.join(dir, 'tests', '__screenshots__', 'chromium')).sort();
    assert.deepStrictEqual(shots, ['about-desktop.png', 'about-mobile.png', 'home-desktop.png', 'home-mobile.png']);
    const second = await pw([]);
    assert.strictEqual(second.code, 0, 'unchanged run should pass (clock masked, banner hidden):\n' + second.text.slice(-2500));
    assert.ok(/4 passed/.test(second.text), second.text.slice(-500));
    await new Promise((resolve, reject) => require('http').get('http://127.0.0.1:' + port + '/__change', r => { r.resume(); r.on('end', resolve); }).on('error', reject));
    const third = await pw([]);
    assert.strictEqual(third.code, 1, 'a changed button colour must fail:\n' + third.text.slice(-1500));
    assert.ok(/4 failed/.test(third.text), third.text.slice(-800));
    assert.ok(fs.existsSync(path.join(dir, 'playwright-report', 'index.html')), 'HTML report written');
    const diffs = [];
    (function walk(d) { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else if (/-diff\.png$/.test(n)) diffs.push(n); } })(path.join(dir, 'test-results'));
    assert.strictEqual(diffs.length, 4, 'a diff image per failed screenshot');
  } finally {
    server.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

(async () => {
  for (const [name, fn] of queue) {
    try {
      const r = await fn();
      if (r === 'skip') { skipped++; console.log('  skip ' + name); } else { passed++; console.log('  ok  ' + name); }
    } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e)); }
  }
  console.log(`\n${passed} passed, ${failed} failed${skipped ? ', ' + skipped + ' skipped' : ''}`);
  process.exit(failed ? 1 : 0);
})();
