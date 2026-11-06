#!/usr/bin/env python3
"""Builds the /explain/ pages: wraps each explain/pages/<slug>.html fragment in the site's header and footer.

Each fragment starts with a JSON block in an HTML comment:
  <!--{"title": "...", "description": "...", "og_title": "...", "scripts": ["/explain/js/stats.js", ...]}-->
and the rest is the page's <main> content. Slug "index" is the /explain/ hub.
Writes docs/explain/<slug>/index.html (and docs/explain/index.html). The maths lives in docs/explain/js/ and is
tested by `node explain/test-explain.js`.

Run:  python3 explain/build.py
"""
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGES = Path(__file__).parent / 'pages'
OUT = ROOT / 'docs' / 'explain'
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
</head>
<body data-present>
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
        <a href="/#contact">Book a free call</a>
        <a href="/hire/">For recruiters</a>
      </div>
      <div>
        <h2>Free resources</h2>
        <a href="/interview-prep/">Interview prep</a>
        <a href="/guides/">Guides</a>
        <a href="/tools/">Calculators</a>
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
      <p>© <span data-year>2026</span> Pawan Sinha · QA &amp; Test Automation Engineer</p>
      <p>ABN 43 627 514 346</p>
    </div>
  </footer>

{scripts}
  <script src="/chat.js" data-mode="services" data-endpoint="{endpoint}" data-booking-url="https://calendly.com/pawansinha4u/30min" defer></script>
  <script src="/glow.js" defer></script>
  <script src="/menu.js" defer></script>
</body>
</html>
"""

META = re.compile(r'\A\s*<!--(\{.*?\})-->\s*', re.S)


def build():
    written = []
    for src in sorted(PAGES.glob('*.html')):
        text = src.read_text()
        m = META.match(text)
        if not m:
            raise SystemExit(f'{src.name}: missing JSON header comment')
        meta = json.loads(m.group(1))
        body = text[m.end():].rstrip() + '\n'
        slug = src.stem
        path = '/explain/' if slug == 'index' else f'/explain/{slug}/'
        out = OUT / 'index.html' if slug == 'index' else OUT / slug / 'index.html'
        scripts = '\n'.join(f'  <script src="{s}"></script>' for s in meta.get('scripts', []))
        page = SHELL.format(
            title=html.escape(meta['title']), description=html.escape(meta['description']),
            og_title=html.escape(meta.get('og_title', meta['title'])), url=SITE + path,
            body=body, scripts=scripts, endpoint=ENDPOINT)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(page)
        written.append(path)
    print('wrote ' + ', '.join(written))


if __name__ == '__main__':
    build()
