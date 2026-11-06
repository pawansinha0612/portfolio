#!/usr/bin/env python3
"""Builds the /guides/ section: how-to guides, cheat sheets, the learning path and free templates.

Every page is an HTML fragment under guides/pages/, mirrored to a URL:
  guides/pages/index.html               -> /guides/
  guides/pages/jmeter/index.html        -> /guides/jmeter/
  guides/pages/jmeter/correlation.html  -> /guides/jmeter/correlation/

Each fragment starts with a JSON header in an HTML comment, then the page's <main> content:
  <!--{"title": "...", "description": "...",          required (description <= 160 chars)
       "og_title": "...",                             optional
       "nav": "learn" | "tools",                      optional, which menu item is highlighted (default learn)
       "scripts": ["/guides/js/x.js"],                optional, loaded before chat.js/menu.js
       "styles": ["/guides/x.css"],                   optional, extra stylesheets
       "present": true,                               optional, adds presenter mode (body data-present)
       "article": true,                               optional, emits TechArticle JSON-LD
       "sitemap": false}-->                           optional, leave the page out of sitemap.xml
Page building blocks (styles in docs/explain/explain.css + docs/guides/guides.css):
  <section class="wrap ex-hero"> eyebrow/h1/lead, <section class="wrap ex-prose"> running text,
  <pre class="ex-code"><code>...</code></pre> code (HTML-escaped; guides.js adds a Copy button),
  <div class="g-note">, <div class="g-warn"> callouts, <table class="g-table"> tables,
  <section class="wrap cta-end"><div class="cta-panel">...</div></section> end call-to-action.

Writes docs/guides/**/index.html and the guides block in docs/sitemap.xml.
Run:  python3 guides/build.py
"""
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGES = Path(__file__).parent / 'pages'
OUT = ROOT / 'docs' / 'guides'
SITEMAP = ROOT / 'docs' / 'sitemap.xml'
SITE = 'https://pawansinha.com.au'
ENDPOINT = 'https://script.google.com/macros/s/AKfycbzvFENGzJ59oV9fx3Vc6CFzkjVpv5uFCx3Ob4zp_gfw0tNCXCI8TQYwJ9zQfkHQrARF/exec'

SHELL = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title} — Pawan Sinha</title>
  <meta name="description" content="{description}">
  <meta property="og:title" content="{og_title}">
  <meta property="og:description" content="{description}">
  <meta property="og:type" content="website">
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
  <link rel="stylesheet" href="/explain/explain.css">
  <link rel="stylesheet" href="/guides/guides.css">
{styles}{jsonld}  <!-- AdSense (content pages only) -->
  <meta name="google-adsense-account" content="ca-pub-8128510632378263">
  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8128510632378263" crossorigin="anonymous"></script>
</head>
<body{body_attr}>
  <header class="nav">
    <div class="wrap nav-inner">
      <a class="brand" href="/"><span class="logo" aria-hidden="true"></span>Pawan Sinha</a>
      <nav id="site-menu" aria-label="Main">
        <a href="/#services">Services</a>
        <a href="/#work">Work</a>
        <a href="/tools/"{cur_tools}>Tools</a>
        <a href="/learn/"{cur_learn}>Learn</a>
        <a href="/blog/">Blog</a>
        <a href="/#contact" class="btn btn-small">Hire me</a>
      </nav>
      <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-menu" aria-label="Open menu"><span></span></button>
    </div>
  </header>

  <main>
{body}
  </main>

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
        <a href="/performance-testing-australia/">Performance testing in Australia</a>
        <a href="/#contact">Book a free call</a>
        <a href="/hire/">For recruiters</a>
      </div>
      <div>
        <h2>Free resources</h2>
        <a href="/interview-prep/">Interview prep</a>
        <a href="/tools/">Calculators</a>
        <a href="/guides/">Guides</a>
        <a href="/explain/">Explainers</a>
        <a href="/play/">Games</a>
        <a href="/course/k6/">k6 email course</a>
        <a href="/glossary/">Glossary</a>
        <a href="/blog/">Blog</a>
      </div>
      <div>
        <h2>Built by me</h2>
        <a href="/#projects">Projects</a>
        <a href="/portfolio-template/">Portfolio Website Template</a>
        <a href="/perf-advisor/">Perf Advisor</a>
        <a href="/interview-prep/guide/">Interview Guide</a>
        <a href="/templates/">Test templates</a>
        <a href="/shop/">Shop</a>
      </div>
    </div>
    <div class="wrap footer-bottom">
      <p>© <span data-year>2026</span> Pawan Sinha · Performance Testing Consultant</p>
      <p><a href="/privacy/">Privacy</a> · ABN 43 627 514 346</p>
    </div>
  </footer>

{scripts}
  <script src="/guides/guides.js" defer></script>
  <script src="/chat.js" data-mode="services" data-endpoint="{endpoint}" data-booking-url="https://calendly.com/pawansinha4u/30min" defer></script>
  <script src="/glow.js" defer></script>
  <script src="/menu.js" defer></script>
</body>
</html>
"""

META = re.compile(r'\A\s*<!--(\{.*?\})-->\s*', re.S)


def url_for(src):
    rel = src.relative_to(PAGES).with_suffix('')
    parts = list(rel.parts)
    if parts[-1] == 'index':
        parts = parts[:-1]
    return '/guides/' + ''.join(p + '/' for p in parts)


def jsonld(meta, url):
    if not meta.get('article'):
        return ''
    data = {'@context': 'https://schema.org', '@type': 'TechArticle', 'headline': meta['title'],
            'description': meta['description'], 'url': url,
            'author': {'@type': 'Person', 'name': 'Pawan Sinha', 'url': SITE + '/'},
            'publisher': {'@type': 'Person', 'name': 'Pawan Sinha'}}
    return '  <script type="application/ld+json">' + json.dumps(data) + '</script>\n'


def update_sitemap(paths):
    text = SITEMAP.read_text(encoding='utf-8')
    block = '  <!-- guides:start (generated by guides/build.py) -->\n' + ''.join(
        f'  <url><loc>{SITE}{p}</loc><changefreq>monthly</changefreq><priority>0.7</priority></url>\n' for p in paths
    ) + '  <!-- guides:end -->'
    if '<!-- guides:start' in text:
        text = re.sub(r'  <!-- guides:start.*?<!-- guides:end -->', lambda _: block, text, flags=re.S)
    else:
        text = text.replace('  <!-- blog:start', block + '\n  <!-- blog:start', 1)
    SITEMAP.write_text(text, encoding='utf-8')


def build():
    written, listed = [], []
    for src in sorted(PAGES.rglob('*.html')):
        text = src.read_text(encoding='utf-8')
        m = META.match(text)
        if not m:
            raise SystemExit(f'{src}: missing JSON header comment')
        meta = json.loads(m.group(1))
        for key in ('title', 'description'):
            if not meta.get(key):
                raise SystemExit(f'{src}: header needs "{key}"')
        path = url_for(src)
        nav = meta.get('nav', 'learn')
        page = SHELL.format(
            title=html.escape(meta['title']), description=html.escape(meta['description']),
            og_title=html.escape(meta.get('og_title', meta['title'])), url=SITE + path,
            body=text[m.end():].rstrip() + '\n',
            scripts='\n'.join(f'  <script src="{s}"></script>' for s in meta.get('scripts', [])),
            styles=''.join(f'  <link rel="stylesheet" href="{s}">\n' for s in meta.get('styles', [])),
            jsonld=jsonld(meta, SITE + path),
            body_attr=' data-present' if meta.get('present') else '',
            cur_tools=' aria-current="page"' if nav == 'tools' else '',
            cur_learn=' aria-current="page"' if nav == 'learn' else '',
            endpoint=ENDPOINT)
        out = OUT / path[len('/guides/'):] / 'index.html'
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(page, encoding='utf-8')
        written.append(path)
        if meta.get('sitemap', True):
            listed.append(path)
    update_sitemap(listed)
    print(f'wrote {len(written)} pages: ' + ', '.join(written))


if __name__ == '__main__':
    build()
