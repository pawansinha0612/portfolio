/* Visual Regression Checker: pure functions, no DOM. Runs in the browser (window.VisualRegression), in a Web Worker
   (worker.js) and in Node (module.exports) for toolkit-tests/visual-regression.test.js. Nothing is sent anywhere.

   diffImages(a, b, opts)      pixel diff of two RGBA images ({ width, height, data }) using the YIQ colour distance
                               with anti-aliasing detection (the approach popularised by pixelmatch), ignore regions,
                               and size differences. Returns counts, change %, a bounding box and a diff image.
   pairFiles(base, next)       pair screenshots by relative path or file name
   verdict(r, maxPct)          pass / fail against a change threshold
   reportHTML(model)           a self-contained HTML report with thumbnails
   generateCI(opts)            Playwright toHaveScreenshot config + spec, GitHub Actions workflow and package.json */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ colour maths
  // YIQ is closer to how people see colour difference than plain RGB distance. 35215 is the largest possible delta.
  const MAX_DELTA = 35215;
  const rgb2y = (r, g, b) => r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
  const rgb2i = (r, g, b) => r * 0.59597799 - g * 0.27417610 - b * 0.32180189;
  const rgb2q = (r, g, b) => r * 0.21147017 - g * 0.52261711 + b * 0.31114694;
  const blend = (c, a) => 255 + (c - 255) * a; // flatten transparency onto white

  function colorDelta(d1, d2, k, m, yOnly) {
    let r1 = d1[k], g1 = d1[k + 1], b1 = d1[k + 2], a1 = d1[k + 3];
    let r2 = d2[m], g2 = d2[m + 1], b2 = d2[m + 2], a2 = d2[m + 3];
    if (a1 === a2 && r1 === r2 && g1 === g2 && b1 === b2) return 0;
    if (a1 < 255) { a1 /= 255; r1 = blend(r1, a1); g1 = blend(g1, a1); b1 = blend(b1, a1); }
    if (a2 < 255) { a2 /= 255; r2 = blend(r2, a2); g2 = blend(g2, a2); b2 = blend(b2, a2); }
    const y1 = rgb2y(r1, g1, b1), y2 = rgb2y(r2, g2, b2), y = y1 - y2;
    if (yOnly) return y;
    const i = rgb2i(r1, g1, b1) - rgb2i(r2, g2, b2), q = rgb2q(r1, g1, b1) - rgb2q(r2, g2, b2);
    const delta = 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
    return y1 > y2 ? -delta : delta;
  }

  // a pixel with more than two identical neighbours sits in a flat area, not on an anti-aliased edge
  function hasManySiblings(d, x1, y1, w, h) {
    const x0 = Math.max(x1 - 1, 0), y0 = Math.max(y1 - 1, 0), x2 = Math.min(x1 + 1, w - 1), y2 = Math.min(y1 + 1, h - 1);
    const pos = (y1 * w + x1) * 4;
    let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;
    for (let x = x0; x <= x2; x++) {
      for (let y = y0; y <= y2; y++) {
        if (x === x1 && y === y1) continue;
        const p = (y * w + x) * 4;
        if (d[pos] === d[p] && d[pos + 1] === d[p + 1] && d[pos + 2] === d[p + 2] && d[pos + 3] === d[p + 3]) zeroes++;
        if (zeroes > 2) return true;
      }
    }
    return false;
  }

  // is the pixel at (x1, y1) of image d1 likely an anti-aliased edge pixel? (compared with its own neighbours)
  function antialiased(d1, x1, y1, w, h, d2) {
    const x0 = Math.max(x1 - 1, 0), y0 = Math.max(y1 - 1, 0), x2 = Math.min(x1 + 1, w - 1), y2 = Math.min(y1 + 1, h - 1);
    const pos = (y1 * w + x1) * 4;
    let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;
    let min = 0, max = 0, minX = 0, minY = 0, maxX = 0, maxY = 0;
    for (let x = x0; x <= x2; x++) {
      for (let y = y0; y <= y2; y++) {
        if (x === x1 && y === y1) continue;
        const delta = colorDelta(d1, d1, pos, (y * w + x) * 4, true);
        if (delta === 0) { zeroes++; if (zeroes > 2) return false; }
        else if (delta < min) { min = delta; minX = x; minY = y; }
        else if (delta > max) { max = delta; maxX = x; maxY = y; }
      }
    }
    if (min === 0 || max === 0) return false;
    return (hasManySiblings(d1, minX, minY, w, h) && hasManySiblings(d2, minX, minY, w, h))
      || (hasManySiblings(d1, maxX, maxY, w, h) && hasManySiblings(d2, maxX, maxY, w, h));
  }

  // put an image on a larger transparent canvas (top-left aligned) so two sizes can be compared
  function pad(img, w, h) {
    if (img.width === w && img.height === h) return img.data;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < img.height && y < h; y++) {
      const src = img.data.subarray(y * img.width * 4, y * img.width * 4 + Math.min(img.width, w) * 4);
      out.set(src, y * w * 4);
    }
    return out;
  }

  /* opts: threshold (0–1, default 0.1: colour difference tolerance), includeAA (count anti-aliased pixels as changes),
     ignore: [{ x, y, w, h }] regions to skip, sizeMode: 'pad' (extra area counts as changed) | 'crop' (compare the overlap),
     output: false to skip the diff image, alpha: how faded unchanged pixels are drawn (0–1) */
  function diffImages(a, b, opts) {
    const o = Object.assign({ threshold: 0.1, includeAA: false, ignore: [], sizeMode: 'pad', output: true, alpha: 0.15 }, opts || {});
    if (!a || !b || !a.data || !b.data) throw new Error('Two images are needed.');
    const sizeMismatch = a.width !== b.width || a.height !== b.height;
    const w = o.sizeMode === 'crop' ? Math.min(a.width, b.width) : Math.max(a.width, b.width);
    const h = o.sizeMode === 'crop' ? Math.min(a.height, b.height) : Math.max(a.height, b.height);
    const d1 = sizeMismatch ? (o.sizeMode === 'crop' ? crop(a, w, h) : pad(a, w, h)) : a.data;
    const d2 = sizeMismatch ? (o.sizeMode === 'crop' ? crop(b, w, h) : pad(b, w, h)) : b.data;
    const out = o.output ? new Uint8ClampedArray(w * h * 4) : null;
    const maxDelta = MAX_DELTA * o.threshold * o.threshold;
    const ign = buildMask(o.ignore, w, h);
    const inA = (x, y) => x < a.width && y < a.height, inB = (x, y) => x < b.width && y < b.height;
    let diff = 0, aa = 0, ignored = 0, outside = 0;
    let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x, pos = p * 4;
        if (ign && ign[p]) {
          ignored++;
          if (out) { out[pos] = 80; out[pos + 1] = 120; out[pos + 2] = 220; out[pos + 3] = 90; }
          continue;
        }
        let state = 0; // 0 same, 1 diff, 2 anti-aliasing
        if (sizeMismatch && o.sizeMode === 'pad' && (!inA(x, y) || !inB(x, y))) { state = 1; outside++; }
        else {
          const delta = colorDelta(d1, d2, pos, pos, false);
          if (Math.abs(delta) > maxDelta) {
            if (!o.includeAA && (antialiased(d1, x, y, w, h, d2) || antialiased(d2, x, y, w, h, d1))) state = 2;
            else state = 1;
          }
        }
        if (state === 1) {
          diff++;
          if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
          if (out) { out[pos] = 230; out[pos + 1] = 30; out[pos + 2] = 50; out[pos + 3] = 255; }
        } else if (state === 2) {
          aa++;
          if (out) { out[pos] = 250; out[pos + 1] = 200; out[pos + 2] = 0; out[pos + 3] = 255; }
        } else if (out) {
          // faded greyscale of the new image so the change has context
          const g = 255 + (rgb2y(d2[pos], d2[pos + 1], d2[pos + 2]) - 255) * o.alpha * (d2[pos + 3] / 255);
          out[pos] = out[pos + 1] = out[pos + 2] = g; out[pos + 3] = 255;
        }
      }
    }
    const compared = w * h - ignored;
    return {
      width: w, height: h, diffPixels: diff, aaPixels: aa, ignoredPixels: ignored, outsidePixels: outside, comparedPixels: compared,
      changePct: compared ? (100 * diff) / compared : 0, sizeMismatch, sizeA: [a.width, a.height], sizeB: [b.width, b.height],
      bbox: bx1 < 0 ? null : { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 }, output: out,
    };
  }
  function crop(img, w, h) {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) out.set(img.data.subarray(y * img.width * 4, y * img.width * 4 + w * 4), y * w * 4);
    return out;
  }
  function buildMask(regions, w, h) {
    const rs = (regions || []).map(normRect).filter(r => r.w > 0 && r.h > 0);
    if (!rs.length) return null;
    const m = new Uint8Array(w * h);
    rs.forEach(r => {
      const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
      const x1 = Math.min(w, Math.ceil(r.x + r.w)), y1 = Math.min(h, Math.ceil(r.y + r.h));
      for (let y = y0; y < y1; y++) m.fill(1, y * w + x0, y * w + Math.max(x0, x1));
    });
    return m;
  }
  // rectangles drawn right-to-left or bottom-to-top have negative sizes
  function normRect(r) {
    const x = r.w < 0 ? r.x + r.w : r.x, y = r.h < 0 ? r.y + r.h : r.y;
    return { x, y, w: Math.abs(r.w), h: Math.abs(r.h) };
  }

  function verdict(r, maxPct) {
    const lim = maxPct == null ? 0.1 : +maxPct;
    if (!r) return 'missing';
    if (r.diffPixels === 0) return 'same';
    return r.changePct <= lim ? 'pass' : 'fail';
  }

  // ------------------------------------------------------------------ pairing
  const STRIP = /[-_.](expected|actual|baseline|base|new|current|reference|ref|before|after|old|diff)$/i;
  function fileKey(f) {
    let p = String((f && (f.path || f.webkitRelativePath)) || (f && f.name) || '').replace(/\\/g, '/');
    // a folder pick includes the chosen folder name first: baseline/home/desktop.png → home/desktop.png
    if (f && f.fromFolder && p.includes('/')) p = p.slice(p.indexOf('/') + 1);
    const parts = p.split('/');
    let name = parts.pop();
    const ext = /\.[a-z0-9]+$/i.exec(name);
    name = name.replace(/\.[a-z0-9]+$/i, '').replace(STRIP, '');
    return { full: (parts.concat(name).join('/') + (ext ? ext[0] : '')).toLowerCase(), base: (name + (ext ? ext[0] : '')).toLowerCase() };
  }
  function pairFiles(baseList, newList) {
    const B = (baseList || []).map(f => ({ f, k: fileKey(f) })), N = (newList || []).map(f => ({ f, k: fileKey(f) }));
    const used = new Set(), pairs = [], onlyNew = [];
    const byFull = new Map(), byBase = new Map();
    B.forEach((x, i) => { if (!byFull.has(x.k.full)) byFull.set(x.k.full, i); const l = byBase.get(x.k.base) || []; l.push(i); byBase.set(x.k.base, l); });
    N.forEach(n => {
      let i = byFull.get(n.k.full);
      if (i == null || used.has(i)) {
        const l = (byBase.get(n.k.base) || []).filter(j => !used.has(j));
        i = l.length === 1 ? l[0] : null;
      }
      if (i == null) { onlyNew.push(n.f); return; }
      used.add(i);
      pairs.push({ key: n.k.full, base: B[i].f, next: n.f });
    });
    const onlyBase = B.filter((x, i) => !used.has(i)).map(x => x.f);
    pairs.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
    return { pairs, onlyBase, onlyNew };
  }

  // ------------------------------------------------------------------ HTML report
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeImg = u => (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(u || '') ? u : '');
  function reportHTML(m) {
    const items = m.items || [];
    const fails = items.filter(i => i.status === 'fail').length, passes = items.filter(i => i.status === 'pass' || i.status === 'same').length;
    const label = { fail: 'Changed', pass: 'Within threshold', same: 'Identical', missing: 'Missing' };
    const img = (u, alt) => (safeImg(u) ? '<a href="' + safeImg(u) + '" target="_blank"><img src="' + safeImg(u) + '" alt="' + esc(alt) + '" loading="lazy"></a>' : '<div class="none">' + esc(alt) + ': none</div>');
    return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Visual regression report</title>'
      + '<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:24px;color:#1b2030;background:#f6f7fb}h1{margin:0 0 4px}p.meta{color:#5b6476;margin:0 0 16px}'
      + '.sum{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 20px}.sum b{display:block;font-size:24px}.sum div{background:#fff;border:1px solid #dde1ea;border-radius:10px;padding:10px 16px}'
      + '.item{background:#fff;border:1px solid #dde1ea;border-left:5px solid #9aa3b5;border-radius:10px;padding:12px 16px;margin:0 0 14px}.item.fail{border-left-color:#c2341d}.item.pass,.item.same{border-left-color:#12a77a}'
      + '.item h2{font-size:16px;margin:0 0 4px;overflow-wrap:anywhere}.item p{margin:0 0 8px;color:#5b6476;font-size:14px}.imgs{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}'
      + '.imgs figure{margin:0}.imgs figcaption{font-size:12px;color:#5b6476}.imgs img{width:100%;height:auto;border:1px solid #dde1ea;border-radius:6px;background:#fff}.none{color:#5b6476;font-size:13px;padding:20px;border:1px dashed #dde1ea;border-radius:6px}'
      + '.st{font-weight:700}.fail .st{color:#c2341d}.pass .st,.same .st{color:#12a77a}</style></head><body>'
      + '<h1>Visual regression report</h1><p class="meta">' + esc(m.date || '') + ' · change threshold ' + esc(m.maxPct) + '% · colour tolerance ' + esc(m.threshold) + '</p>'
      + '<div class="sum"><div><b>' + items.length + '</b>compared</div><div><b>' + fails + '</b>changed</div><div><b>' + passes + '</b>passed</div>'
      + '<div><b>' + (m.onlyBase || []).length + '</b>missing in new</div><div><b>' + (m.onlyNew || []).length + '</b>new only</div></div>'
      + items.map(i => '<section class="item ' + esc(i.status) + '"><h2>' + esc(i.name) + '</h2><p><span class="st">' + esc(label[i.status] || i.status) + '</span> · '
        + (i.changePct == null ? '' : i.changePct.toFixed(3) + '% of pixels changed (' + Number(i.diffPixels).toLocaleString('en-AU') + ')') + (i.sizeNote ? ' · ' + esc(i.sizeNote) : '') + '</p>'
        + '<div class="imgs"><figure>' + img(i.baseThumb, 'Baseline') + '<figcaption>Baseline</figcaption></figure><figure>' + img(i.newThumb, 'New') + '<figcaption>New</figcaption></figure><figure>'
        + img(i.diffThumb, 'Difference') + '<figcaption>Difference (red = changed)</figcaption></figure></div></section>').join('')
      + ((m.onlyBase || []).length ? '<h2>Missing in the new build</h2><ul>' + m.onlyBase.map(n => '<li>' + esc(n) + '</li>').join('') + '</ul>' : '')
      + ((m.onlyNew || []).length ? '<h2>Only in the new build (no baseline yet)</h2><ul>' + m.onlyNew.map(n => '<li>' + esc(n) + '</li>').join('') + '</ul>' : '')
      + '<p class="meta">Made with the free Visual Regression Checker: https://pawansinha.com.au/tools/visual-regression/</p></body></html>\n';
  }

  // ------------------------------------------------------------------ CI generator (Playwright toHaveScreenshot)
  const slug = s => String(s).toLowerCase().replace(/^https?:\/\/[^/]+/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'home';
  const tsStr = s => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'";
  const yamlStr = s => "'" + String(s).replace(/'/g, "''") + "'";
  function parsePages(text) {
    const out = [], seen = new Set();
    String(text || '').split(/\r?\n/).forEach(line => {
      const l = line.trim();
      if (!l || l.startsWith('#')) return;
      let name = '', p = l;
      const m = /^(.+?)\s*(?:\||,|\t|=)\s*(\S+)$/.exec(l) || /^(.+?)\s+((?:https?:\/\/|\/)\S*)$/.exec(l);
      if (m) { name = m[1].trim(); p = m[2].trim(); }
      if (!/^(https?:\/\/|\/)/.test(p)) p = '/' + p.replace(/^\.?\//, '');
      let n = slug(name || p.replace(/[?#].*$/, ''));
      while (seen.has(n)) n += '-2';
      seen.add(n);
      out.push({ name: n, path: p });
    });
    return out;
  }
  const VIEWPORTS = { mobile: { name: 'mobile', width: 375, height: 812 }, tablet: { name: 'tablet', width: 768, height: 1024 }, desktop: { name: 'desktop', width: 1280, height: 800 }, wide: { name: 'wide', width: 1920, height: 1080 } };
  const BROWSERS = { chromium: "devices['Desktop Chrome']", firefox: "devices['Desktop Firefox']", webkit: "devices['Desktop Safari']" };

  function generateCI(opts) {
    const o = Object.assign({ baseURL: 'https://example.com', pages: '/', viewports: ['mobile', 'desktop'], browsers: ['chromium'], maxDiffPixelRatio: 0.01, threshold: 0.1,
      fullPage: true, masks: '', hideSelectors: '', waitUntil: 'networkidle', playwrightVersion: '1.48.0', nodeVersion: 20 }, opts || {});
    const pages = Array.isArray(o.pages) ? o.pages : parsePages(o.pages);
    if (!pages.length) throw new Error('Add at least one page path or URL.');
    const vps = (o.viewports || []).map(v => (typeof v === 'string' ? VIEWPORTS[v] : v)).filter(Boolean);
    if (!vps.length) throw new Error('Pick at least one screen size.');
    const browsers = (o.browsers || []).filter(b => BROWSERS[b]);
    if (!browsers.length) browsers.push('chromium');
    let base = String(o.baseURL || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s'"]+$/.test(base)) throw new Error('The base URL must start with http:// or https://');
    const ratio = Math.max(0, Math.min(1, +o.maxDiffPixelRatio || 0));
    const thr = Math.max(0, Math.min(1, o.threshold == null ? 0.1 : +o.threshold));
    const list = s => String(s || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const masks = list(o.masks), hides = list(o.hideSelectors);
    const waitUntil = ['load', 'domcontentloaded', 'networkidle'].includes(o.waitUntil) ? o.waitUntil : 'networkidle';

    const config = `import { defineConfig, devices } from '@playwright/test';

// Visual regression config. Baselines live in tests/__screenshots__ and are committed to git.
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['html', { open: 'never' }], ['list']],
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}',
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: ${ratio},
      threshold: ${thr},
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  use: {
    baseURL: process.env.BASE_URL || ${tsStr(base)},
    trace: 'retain-on-failure',
  },
  projects: [
${browsers.map(b => `    { name: '${b}', use: { ...${BROWSERS[b]} } },`).join('\n')}
  ],
});
`;

    const spec = `import { test, expect } from '@playwright/test';

// One screenshot per page per screen size. Run with --update-snapshots to accept changes as the new baseline.
const pages: { name: string; path: string }[] = [
${pages.map(p => `  { name: ${tsStr(p.name)}, path: ${tsStr(p.path)} },`).join('\n')}
];

const viewports: { name: string; width: number; height: number }[] = [
${vps.map(v => `  { name: ${tsStr(v.name)}, width: ${v.width | 0}, height: ${v.height | 0} },`).join('\n')}
];

// Parts that change on every load (dates, ads, carousels): covered with a solid box in the screenshot.
const masks: string[] = [${masks.map(tsStr).join(', ')}];

// Parts to hide completely (cookie banners, chat widgets).
const hideCss = ${tsStr(hides.length ? hides.join(', ') + ' { visibility: hidden !important; }' : '')};

for (const vp of viewports) {
  test.describe(\`\${vp.name} \${vp.width}x\${vp.height}\`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    for (const p of pages) {
      test(p.name, async ({ page }) => {
        await page.goto(p.path, { waitUntil: '${waitUntil}' });
        await page.evaluate(async () => { await document.fonts.ready; });
        if (hideCss) await page.addStyleTag({ content: hideCss });
        await expect(page).toHaveScreenshot(\`\${p.name}-\${vp.name}.png\`, {
          fullPage: ${o.fullPage ? 'true' : 'false'},
          mask: masks.map((s) => page.locator(s)),
        });
      });
    }
  });
}
`;

    const pkg = JSON.stringify({ name: 'visual-regression', private: true, scripts: { test: 'playwright test', 'test:update': 'playwright test --update-snapshots', report: 'playwright show-report' },
      devDependencies: { '@playwright/test': '^' + String(o.playwrightVersion) } }, null, 2) + '\n';

    const browserList = browsers.join(' ');
    const workflow = `# .github/workflows/visual-regression.yml
# Free visual regression testing on GitHub Actions with Playwright.
# - On every pull request: compare screenshots with the committed baselines; fail on a visual change.
# - Run it by hand with "update baselines" ticked to accept the current look as the new baseline.
name: Visual regression

on:
  pull_request:
  workflow_dispatch:
    inputs:
      update:
        description: Update the baseline screenshots
        type: boolean
        default: false

permissions:
  contents: write

jobs:
  visual:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    env:
      BASE_URL: \${{ vars.BASE_URL || ${yamlStr(base)} }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: ${(o.nodeVersion | 0) || 20}

      - name: Install Playwright
        run: |
          npm install --no-audit --no-fund
          npx playwright install --with-deps ${browserList}

      - name: Compare with baselines
        if: \${{ !inputs.update }}
        run: npx playwright test

      - name: Update baselines
        if: \${{ inputs.update }}
        run: |
          npx playwright test --update-snapshots
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add tests/__screenshots__
          git commit -m "Update visual baselines" || echo "No changes"
          git push

      - name: Upload the HTML report (with diffs)
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: visual-report
          path: |
            playwright-report/
            test-results/
          retention-days: 14
`;
    const readme = `Visual regression with Playwright (free)

1. Put package.json, playwright.config.ts and tests/visual.spec.ts in a folder of your repository
   (or merge them into an existing Playwright project), and the workflow in .github/workflows/.
2. Create the first baselines on GitHub, not on your laptop: Actions → Visual regression → Run workflow,
   tick "Update the baseline screenshots". Fonts render differently on macOS, Windows and Linux,
   so baselines must come from the same system that compares them (the Linux runner).
3. Every pull request now compares the pages with the baselines. A visual change fails the job;
   download the "visual-report" artifact and open playwright-report/index.html to see
   expected, actual and diff images side by side.
4. Change is intended? Run the workflow again with "update baselines" ticked
   (or locally: npx playwright test --update-snapshots inside the Playwright Docker image
   mcr.microsoft.com/playwright:v<version>-noble, where <version> is what npx playwright --version prints,
   so the rendering matches CI).
5. Set the BASE_URL repository variable (Settings → Secrets and variables → Actions → Variables)
   to test a preview or staging URL instead of ${base}.
`;
    const shots = pages.length * vps.length * browsers.length;
    return { config, spec, workflow, pkg, readme, pages, viewports: vps, browsers, screenshots: shots,
      files: [{ name: 'playwright.config.ts', content: config }, { name: 'tests/visual.spec.ts', content: spec }, { name: '.github/workflows/visual-regression.yml', content: workflow }, { name: 'package.json', content: pkg }, { name: 'VISUAL-TESTS.md', content: readme }] };
  }

  const api = { diffImages, colorDelta, antialiased, verdict, pairFiles, fileKey, reportHTML, generateCI, parsePages, normRect, VIEWPORTS, MAX_DELTA };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VisualRegression = api;
})(typeof self !== 'undefined' ? self : this);
