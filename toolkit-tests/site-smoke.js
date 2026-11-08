// Browser check of the whole site: every page in docs/sitemap.xml must load from docs/ with no JavaScript errors,
// and key pages must not scroll sideways on a phone. Needs Playwright (npm i playwright && npx playwright install chromium).
// Run: node toolkit-tests/site-smoke.js     (CI: .github/workflows/site-tests.yml)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DOCS = path.join(__dirname, '..', 'docs');
const SITE = 'https://pawansinha.com.au';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.xml': 'application/xml', '.mp4': 'video/mp4',
  '.woff2': 'font/woff2', '.txt': 'text/plain', '.webmanifest': 'application/manifest+json', '.pdf': 'application/pdf', '.zip': 'application/zip' };
// Errors from outside services (ads, analytics, the Apps Script backend, video embeds) are not site bugs.
const IGNORE = /Failed to load resource|net::ERR|goatcounter|script\.google|googlesyndication|adsbygoogle|doubleclick|youtube|giscus|google-analytics|pagead/i;
// Pages that must also fit a 375px phone screen.
const PHONE = ['/', '/tools/', '/services/performance-testing/', '/learn/', '/blog/', '/guides/', '/interview-prep/', '/hire/', '/shop/', '/site-check/',
  '/tools/perf-studio/', '/tools/qa-copilot/', '/tools/ci-failure-detective/', '/tools/log-analyser/', '/tools/openapi-to-playwright/'];

function serve() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
      let file = path.join(DOCS, p);
      if (!file.startsWith(DOCS)) { res.writeHead(403); return res.end(); }
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    }).listen(0, () => resolve(server));
  });
}

(async () => {
  const sitemap = fs.readFileSync(path.join(DOCS, 'sitemap.xml'), 'utf8');
  const pages = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].replace(SITE, '') || '/');
  const server = await serve();
  const base = 'http://localhost:' + server.address().port;
  const browser = await chromium.launch();
  const problems = [];

  async function check(ctx, p, phone) {
    const page = await ctx.newPage(); const errs = [];
    page.on('pageerror', e => errs.push('JS error: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !IGNORE.test(m.text())) errs.push('console: ' + m.text()); });
    // Block outside requests so the check is fast and doesn't depend on other services.
    await page.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
    try {
      const res = await page.goto(base + p, { waitUntil: 'load', timeout: 30000 });
      if (!res || res.status() !== 200) errs.push('HTTP ' + (res && res.status()));
      await page.waitForTimeout(250);
      if (phone) {
        const sw = await page.evaluate(() => document.documentElement.scrollWidth);
        if (sw > 376) errs.push('scrolls sideways on a phone (' + sw + 'px wide)');
      }
    } catch (e) { errs.push('did not load: ' + e.message.split('\n')[0]); }
    await page.close();
    if (errs.length) problems.push((phone ? '[phone] ' : '') + p + '\n    ' + errs.join('\n    '));
  }

  const desk = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  for (const p of pages) await check(desk, p, false);
  const phone = await browser.newContext({ viewport: { width: 375, height: 800 } });
  for (const p of PHONE) await check(phone, p, true);
  await browser.close(); server.close();

  console.log('Checked ' + pages.length + ' pages (desktop) and ' + PHONE.length + ' pages (phone).');
  if (problems.length) { console.log('\n' + problems.length + ' problem(s):\n  ' + problems.join('\n  ')); process.exit(1); }
  console.log('All pages OK');
})().catch(e => { console.error(e); process.exit(1); });
