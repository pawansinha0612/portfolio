#!/usr/bin/env python3
"""Builds the performance testing glossary.

Writes docs/glossary/index.html (A–Z hub with a filter box) and docs/glossary/<slug>/index.html for every term.
Terms live in glossary/terms_testing.py, terms_metrics.py, terms_systems.py and terms_ai.py (one dict per term).
The build checks the data first and stops on a problem: related terms that don't exist, tool links to pages that
aren't in docs/, prose outside 120–250 words, or semicolons in prose (house style).

Run:            python3 glossary/build.py
Sitemap lines:  python3 glossary/build.py --sitemap   (prints the <url> lines to paste into docs/sitemap.xml)
"""
import html
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from terms_testing import TERMS as T1  # noqa: E402
from terms_metrics import TERMS as T2  # noqa: E402
from terms_systems import TERMS as T3  # noqa: E402
from terms_ai import TERMS as T4  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / 'docs'
OUT = DOCS / 'glossary'
SITE = 'https://pawansinha.com.au'
BOOKING = 'https://calendly.com/pawansinha4u/30min'
ENDPOINT = 'https://script.google.com/macros/s/AKfycbzvFENGzJ59oV9fx3Vc6CFzkjVpv5uFCx3Ob4zp_gfw0tNCXCI8TQYwJ9zQfkHQrARF/exec'

TERMS = sorted(T1 + T2 + T3 + T4, key=lambda t: t['name'].lower())
BY_SLUG = {t['slug']: t for t in TERMS}
CATS = {'testing': 'Test design', 'metrics': 'Metrics and SLOs', 'systems': 'System behaviour', 'observability': 'Observability'}
PROSE = ('definition', 'why', 'example', 'measure')

e = html.escape


def text_of(s):
    return re.sub(r'<[^>]+>', '', s)


def words(t):
    parts = [t[k] for k in PROSE] + t['mistakes']
    return len(text_of(' '.join(parts)).split())


def check():
    errors = []
    slugs = [t['slug'] for t in TERMS]
    if len(slugs) != len(set(slugs)):
        errors.append('duplicate slugs')
    for t in TERMS:
        s = t['slug']
        if not re.fullmatch(r'[a-z0-9-]+', s):
            errors.append(f'{s}: bad slug')
        if t['cat'] not in CATS:
            errors.append(f'{s}: unknown category {t["cat"]}')
        rel = t['related']
        if not 3 <= len(rel) <= 5:
            errors.append(f'{s}: needs 3–5 related terms, has {len(rel)}')
        for r in rel:
            if r not in BY_SLUG or r == s:
                errors.append(f'{s}: related term "{r}" does not exist')
        for href, _ in t.get('links', []):
            path = href.split('#')[0]
            target = DOCS / path.strip('/') / 'index.html' if path.endswith('/') else DOCS / path.strip('/')
            if not target.exists():
                errors.append(f'{s}: link {href} has no page in docs/')
        n = words(t)
        if not 120 <= n <= 250:
            errors.append(f'{s}: {n} words (want 120–250)')
        for k in PROSE:
            if ';' in text_of(t[k]).replace('&amp;', '').replace('&lt;', '').replace('&gt;', ''):
                errors.append(f'{s}: semicolon in {k}')
        for m in t['mistakes']:
            if ';' in text_of(m):
                errors.append(f'{s}: semicolon in a mistake')
        if text_of(t['definition']).count('. ') > 0:
            errors.append(f'{s}: definition should be one sentence')
    if errors:
        sys.exit('Glossary data problems:\n  ' + '\n  '.join(errors))


HEAD = '''<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <meta name="description" content="{desc}">
  <meta property="og:title" content="{title}">
  <meta property="og:description" content="{desc}">
  <meta property="og:type" content="{ogtype}">
  <meta property="og:url" content="{url}">
  <meta property="og:image" content="https://pawansinha.com.au/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="canonical" href="{url}">
  <meta name="theme-color" content="#2557d6">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%232557d6'/><path d='M7 22l6-7 5 4 7-10' stroke='white' stroke-width='3' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles.css">
  <link rel="stylesheet" href="/chat.css">
{jsonld}
  <style>
    .project-hero {{ padding: 64px 16px 8px; max-width: 860px; }}
    .project-hero h1 {{ font-size: clamp(30px, 5vw, 46px); line-height: 1.12; margin: 0 0 16px; overflow-wrap: anywhere; }}
    .project-hero .lead {{ max-width: 760px; }}
    .crumbs {{ font-size: 14px; color: var(--muted); margin: 0 0 18px; }}
    .crumbs a {{ color: var(--muted); }}
    .crumbs a:hover {{ color: var(--accent); }}
    .def {{ font-size: 19px; color: var(--text); border-left: 4px solid var(--accent); padding: 4px 0 4px 16px; margin: 0; }}
    .aka {{ color: var(--muted); font-size: 14px; margin: 14px 0 0; }}
    .guide {{ max-width: 860px; padding: 24px 16px 8px; }}
    .guide h2 {{ font-size: clamp(20px, 2.6vw, 24px); margin: 28px 0 8px; }}
    .guide p, .guide li {{ color: var(--muted); line-height: 1.65; }}
    .guide ul {{ padding-left: 22px; margin: 0; }}
    .guide li + li {{ margin-top: 6px; }}
    .guide strong {{ color: var(--text); }}
    .guide code {{ font: 500 0.9em "JetBrains Mono", monospace; color: var(--text); }}
    .guide pre {{ font: 500 13px/1.6 "JetBrains Mono", ui-monospace, monospace; color: var(--text); background: var(--alt);
      border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; overflow-x: auto; white-space: pre; margin: 12px 0 0; }}
    .guide pre code {{ font: inherit; }}
    .try {{ margin: 28px 0 0; padding: 16px 18px; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); }}
    .try p {{ margin: 0 0 8px; color: var(--text); font-weight: 600; }}
    .try a {{ display: block; font-weight: 600; text-decoration: none; margin-top: 4px; }}
    .guide .chips, .chips {{ display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 0; padding: 0; list-style: none; }}
    .chips a {{ display: inline-block; padding: 6px 14px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface);
      font-size: 14px; font-weight: 600; color: var(--text); text-decoration: none; }}
    .chips a:hover {{ border-color: var(--accent); color: var(--accent); }}
    .tools-end {{ max-width: 860px; padding: 32px 16px 72px; }}
    .letters {{ display: flex; flex-wrap: wrap; gap: 6px; margin: 22px 0 0; padding: 0; list-style: none; }}
    .letters a {{ display: grid; place-items: center; min-width: 34px; height: 34px; border: 1px solid var(--border); border-radius: 10px;
      background: var(--surface); font-weight: 700; font-size: 14px; color: var(--text); text-decoration: none; }}
    .letters a:hover {{ border-color: var(--accent); color: var(--accent); }}
    .filter {{ width: 100%; max-width: 520px; font: inherit; font-size: 16px; color: var(--text); background: var(--surface);
      border: 1px solid var(--border); border-radius: 12px; padding: 11px 14px; margin: 22px 0 0; display: block; }}
    .filter:focus {{ outline: none; border-color: var(--accent); }}
    .count {{ color: var(--muted); font-size: 14px; margin: 8px 0 0; }}
    .az {{ max-width: 860px; padding: 8px 16px 8px; }}
    .group {{ scroll-margin-top: 80px; }}
    .group h2 {{ font-size: 24px; margin: 28px 0 10px; color: var(--accent); }}
    .terms {{ list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }}
    .terms a {{ display: block; padding: 14px 16px; border: 1px solid var(--border); border-radius: 14px; background: var(--surface);
      text-decoration: none; color: var(--text); }}
    .terms a:hover {{ border-color: var(--accent); }}
    .terms b {{ display: block; font-size: 16px; }}
    .terms span {{ display: block; color: var(--muted); font-size: 14px; margin-top: 2px; line-height: 1.5; }}
    .terms small {{ display: inline-block; margin-top: 6px; font-size: 12px; font-weight: 700; color: var(--accent); text-transform: uppercase; letter-spacing: .06em; }}
    .none {{ color: var(--muted); margin: 24px 0 0; }}
    @media (max-width: 600px) {{ .project-hero {{ padding-top: 40px; }} }}
  </style>
  <!-- AdSense (content pages only) -->
  <meta name="google-adsense-account" content="ca-pub-8128510632378263">
  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8128510632378263" crossorigin="anonymous"></script>
</head>
<body>
  <header class="nav">
    <div class="wrap nav-inner">
      <a class="brand" href="/"><span class="logo" aria-hidden="true"></span>Pawan Sinha</a>
      <nav id="site-menu" aria-label="Main">
        <a href="/#services">Services</a>
        <a href="/#work">Work</a>
        <a href="/tools/">Tools</a>
        <a href="/learn/" aria-current="page">Learn</a>
        <a href="/blog/">Blog</a>
        <a href="/#contact" class="btn btn-small">Hire me</a>
      </nav>
      <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-menu" aria-label="Open menu"><span></span></button>
    </div>
  </header>

  <main>
'''

FOOT = '''  </main>

  <footer class="site-footer">
    <div class="wrap footer-grid">
      <div class="footer-about">
        <a class="brand" href="/"><span class="logo" aria-hidden="true"></span>Pawan Sinha</a>
        <p>Software testing and performance engineering for teams that can't afford to ship bugs. Melbourne, Australia. Remote, hybrid or on-site.</p>
        <p><a href="mailto:hello@pawansinha.com.au">hello@pawansinha.com.au</a> · <a href="https://www.linkedin.com/in/pawan-sinha-b5a356b6/" target="_blank" rel="noopener">LinkedIn</a></p>
      </div>
      <div>
        <h2>Work with me</h2>
        <a href="/#services">Services</a>
        <a href="/#engage">Engagements</a>
        <a href="/#work">Case studies</a>
        <a href="/peak-readiness/">Peak-readiness load test</a>
        <a href="/#contact">Book a free call</a>
        <a href="/hire/">For recruiters</a>
      </div>
      <div>
        <h2>Free resources</h2>
        <a href="/interview-prep/">Interview prep</a>
        <a href="/guides/">Guides</a>
        <a href="/tools/">Calculators</a>
        <a href="/interview-prep/practice/">Interview practice</a>
        <a href="/course/k6/">k6 email course</a>
        <a href="/peak-readiness/quiz/">Peak-readiness quiz</a>
        <a href="/jobs/">Testing jobs</a>
        <a href="/blog/">Blog</a>
        <a href="/blog/feed.xml">RSS feed</a>
      </div>
      <div>
        <h2>Built by me</h2>
        <a href="/#projects">Projects</a>
        <a href="/projects/deal-finder/">Melbourne Deal Finder</a>
        <a href="/portfolio-template/">Portfolio Website Template</a>
        <a href="/perf-advisor/">Perf Advisor</a>
        <a href="/interview-prep/guide/">Interview Guide</a>
        <a href="/templates/">Test templates</a>
        <a href="/shop/">Shop</a>
      </div>
    </div>
    <div class="wrap footer-bottom">
      <p>© <span data-year>2026</span> Pawan Sinha · QA &amp; Test Automation Engineer</p>
      <p><a href="/privacy/">Privacy</a> · ABN 43 627 514 346</p>
    </div>
  </footer>
{extra}
  <script src="/chat.js" data-mode="services" data-endpoint="''' + ENDPOINT + '''" data-booking-url="''' + BOOKING + '''" defer></script>
  <script src="/glow.js" defer></script>
  <script src="/menu.js" defer></script>
</body>
</html>
'''

CTA = '''    <section class="wrap tools-end">
      <div class="offer">
        <div>
          <p class="eyebrow">{eyebrow}</p>
          <h3>{heading}</h3>
          <p>{text}</p>
        </div>
        <div style="flex:0 1 auto;display:flex;flex-wrap:wrap;gap:10px">
          <a class="btn" href="''' + BOOKING + '''" target="_blank" rel="noopener" data-track="glossary-book">Book a free call</a>
          <a class="btn btn-ghost" href="/services/performance-testing/" data-track="glossary-services">Performance testing</a>
        </div>
      </div>
    </section>
'''


def jsonld(*objs):
    return '\n'.join('  <script type="application/ld+json">' + json.dumps(o, ensure_ascii=False) + '</script>' for o in objs)


def h1_of(t):
    return t.get('h1') or f'What is {t["name"]}?'


def term_page(t):
    url = f'{SITE}/glossary/{t["slug"]}/'
    h1 = h1_of(t)
    defn = text_of(t['definition'])
    desc = defn if len(defn) <= 158 else defn[:155].rsplit(' ', 1)[0] + '…'
    term_ld = {'@context': 'https://schema.org', '@type': 'DefinedTerm', 'name': t['name'], 'description': defn, 'url': url,
               'inDefinedTermSet': {'@type': 'DefinedTermSet', 'name': 'Performance testing glossary', 'url': SITE + '/glossary/'}}
    if t.get('aka'):
        term_ld['alternateName'] = t['aka']
    crumbs_ld = {'@context': 'https://schema.org', '@type': 'BreadcrumbList', 'itemListElement': [
        {'@type': 'ListItem', 'position': 1, 'name': 'Home', 'item': SITE + '/'},
        {'@type': 'ListItem', 'position': 2, 'name': 'Glossary', 'item': SITE + '/glossary/'},
        {'@type': 'ListItem', 'position': 3, 'name': t['name'], 'item': url}]}
    out = [HEAD.format(title=e(f'{h1} — Pawan Sinha'), desc=e(desc), url=url, ogtype='article', jsonld=jsonld(term_ld, crumbs_ld))]
    out.append(f'''    <section class="wrap project-hero">
      <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> / <a href="/glossary/">Glossary</a> / {e(t["name"])}</nav>
      <p class="eyebrow">Glossary · {CATS[t["cat"]]}</p>
      <h1>{e(h1)}</h1>
      <p class="def">{t["definition"]}</p>
''')
    if t.get('aka'):
        out.append(f'      <p class="aka">Also called: {e(", ".join(t["aka"]))}</p>\n')
    out.append('    </section>\n\n    <section class="wrap guide">\n')
    out.append(f'      <h2>Why it matters</h2>\n      <p>{t["why"]}</p>\n')
    out.append(f'      <h2>An example</h2>\n      <p>{t["example"]}</p>\n')
    out.append(f'      <h2>How to measure or test it</h2>\n      <p>{t["measure"]}</p>\n')
    if t.get('code'):
        out.append(f'      <pre><code>{e(t["code"].strip())}</code></pre>\n')
    out.append('      <h2>Common mistakes</h2>\n      <ul>\n' + ''.join(f'        <li>{m}</li>\n' for m in t['mistakes']) + '      </ul>\n')
    if t.get('links'):
        out.append('      <div class="try">\n        <p>Try it on this site</p>\n' +
                   ''.join(f'        <a href="{e(h)}">{e(label)} →</a>\n' for h, label in t['links']) + '      </div>\n')
    out.append('      <h2>Related terms</h2>\n      <ul class="chips">\n' +
               ''.join(f'        <li><a href="/glossary/{r}/">{e(BY_SLUG[r]["name"])}</a></li>\n' for r in t['related']) +
               '        <li><a href="/glossary/">All terms</a></li>\n      </ul>\n    </section>\n\n')
    out.append(CTA.format(eyebrow='Need this measured on your system?',
                          heading='Get a load test and a clear answer',
                          text='Definitions are the easy part. A workload model from your own traffic, a test that proves it and a plain-English go/no-go are what you can act on.'))
    out.append(FOOT.format(extra=''))
    return ''.join(out)


def first_letter(t):
    c = t['name'][0].upper()
    return c if c.isalpha() else '#'


def hub():
    url = SITE + '/glossary/'
    groups = {}
    for t in TERMS:
        groups.setdefault(first_letter(t), []).append(t)
    letters = sorted(groups)
    desc = f'Plain-English performance testing glossary: {len(TERMS)} terms from load testing and Little\'s Law to p99, SLOs, Core Web Vitals, connection pools and coordinated omission.'
    set_ld = {'@context': 'https://schema.org', '@type': 'DefinedTermSet', 'name': 'Performance testing glossary', 'url': url,
              'description': desc, 'hasDefinedTerm': [
                  {'@type': 'DefinedTerm', 'name': t['name'], 'url': f'{SITE}/glossary/{t["slug"]}/', 'description': text_of(t['definition'])}
                  for t in TERMS]}
    crumbs_ld = {'@context': 'https://schema.org', '@type': 'BreadcrumbList', 'itemListElement': [
        {'@type': 'ListItem', 'position': 1, 'name': 'Home', 'item': SITE + '/'},
        {'@type': 'ListItem', 'position': 2, 'name': 'Glossary', 'item': url}]}
    out = [HEAD.format(title='Performance Testing Glossary — Pawan Sinha', desc=e(desc), url=url, ogtype='website',
                       jsonld=jsonld(set_ld, crumbs_ld))]
    out.append(f'''    <section class="wrap project-hero">
      <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> / <a href="/learn/">Learn</a> / Glossary</nav>
      <p class="eyebrow">Free resource · {len(TERMS)} terms</p>
      <h1>Performance testing glossary</h1>
      <p class="lead">The words that come up in load tests, capacity plans and incident reviews, each explained in plain English with a worked example, how to measure it and the mistakes people make.</p>
      <label for="filter" class="hp" style="position:absolute;left:-9999px">Filter terms</label>
      <input id="filter" class="filter" type="search" placeholder="Filter terms, e.g. p99, pool, cache" autocomplete="off">
      <p class="count" id="count" aria-live="polite">{len(TERMS)} terms</p>
      <ul class="letters" aria-label="Jump to letter">
''')
    out.append(''.join(f'        <li><a href="#letter-{l.lower() if l != "#" else "num"}">{l}</a></li>\n' for l in letters))
    out.append('      </ul>\n    </section>\n\n    <section class="wrap az">\n')
    for l in letters:
        gid = f'letter-{l.lower() if l != "#" else "num"}'
        out.append(f'      <div class="group" id="{gid}">\n        <h2>{l}</h2>\n        <ul class="terms">\n')
        for t in groups[l]:
            hay = ' '.join([t['name'], ' '.join(t.get('aka', [])), text_of(t['definition']), CATS[t['cat']]]).lower()
            out.append(f'          <li data-text="{e(hay)}"><a href="/glossary/{t["slug"]}/"><b>{e(t["name"])}</b>'
                       f'<span>{e(text_of(t["definition"]))}</span><small>{CATS[t["cat"]]}</small></a></li>\n')
        out.append('        </ul>\n      </div>\n')
    out.append('      <p class="none" id="none" hidden>No terms match. Try a shorter word, or <a href="/#contact">ask me</a>.</p>\n    </section>\n\n')
    out.append(CTA.format(eyebrow='Big event coming up?',
                          heading='Know your numbers before your customers find them',
                          text='I turn your real traffic into a workload model, load test it, find the bottleneck and give you a clear go/no-go.'))
    script = '''
  <script>
    (function () {
      var input = document.getElementById('filter'), count = document.getElementById('count'), none = document.getElementById('none');
      var items = Array.prototype.slice.call(document.querySelectorAll('.terms li'));
      var groups = Array.prototype.slice.call(document.querySelectorAll('.group'));
      var letters = document.querySelector('.letters');
      function run() {
        var q = input.value.trim().toLowerCase(), shown = 0;
        items.forEach(function (li) { var hit = !q || li.getAttribute('data-text').indexOf(q) >= 0; li.hidden = !hit; if (hit) shown++; });
        groups.forEach(function (g) { g.hidden = !g.querySelector('li:not([hidden])'); });
        letters.hidden = !!q;
        none.hidden = shown > 0;
        count.textContent = q ? shown + (shown === 1 ? ' term matches' : ' terms match') : items.length + ' terms';
      }
      input.addEventListener('input', run);
      var q = new URLSearchParams(location.search).get('q');
      if (q) { input.value = q; run(); }
    })();
  </script>'''
    out.append(FOOT.format(extra=script))
    return ''.join(out)


def main():
    check()
    if '--sitemap' in sys.argv:
        print(f'  <url><loc>{SITE}/glossary/</loc><changefreq>monthly</changefreq><priority>0.7</priority></url>')
        for t in TERMS:
            print(f'  <url><loc>{SITE}/glossary/{t["slug"]}/</loc><changefreq>yearly</changefreq><priority>0.5</priority></url>')
        return
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'index.html').write_text(hub())
    for t in TERMS:
        d = OUT / t['slug']
        d.mkdir(exist_ok=True)
        (d / 'index.html').write_text(term_page(t))
    print(f'Wrote docs/glossary/index.html and {len(TERMS)} term pages')


if __name__ == '__main__':
    main()
