#!/usr/bin/env python3
"""Builds the site search index: docs/search/index.json.

Reads every docs/**/index.html that search engines may index (pages with a robots "noindex" meta, the
portfolio-template demo and a few private pages are skipped), and keeps for each page:
  u  URL path, t  title (without " — Pawan Sinha"), d  meta description,
  s  section label (Tool, Guide, Blog, ...), h  h1-h3 headings, x  the start of the main text.
docs/search/search.js loads the file on first use and ranks matches in the browser.

Run:  python3 search/build.py      (the "Search index" workflow runs it on every push and daily)
"""
import json
import re
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / 'docs'
OUT = DOCS / 'search' / 'index.json'
TEXT_CHARS = 1500
SKIP = ('/portfolio-template/demo/', '/linkedin-callback/', '/invoice/', '/feedback/', '/search/', '/404')

SECTIONS = [  # first matching prefix wins
    ('/tools/', 'Tool'), ('/guides/templates/', 'Template'), ('/guides/', 'Guide'), ('/explain/', 'Explainer'),
    ('/glossary/', 'Glossary'), ('/compare/', 'Comparison'), ('/blog/', 'Blog'), ('/interview-prep/', 'Interview prep'),
    ('/course/', 'Course'), ('/play/', 'Game'), ('/services/', 'Service'), ('/jobs/', 'Jobs'), ('/', 'Page'),
]


class Page(HTMLParser):
    SKIP_TAGS = {'script', 'style', 'noscript', 'svg', 'header', 'footer', 'nav', 'form', 'button', 'select', 'template'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = ''
        self.desc = ''
        self.noindex = False
        self.heads, self.text = [], []
        self._in_title = False
        self._in_main = 0
        self._skip = 0
        self._head = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'meta':
            name = (a.get('name') or '').lower()
            if name == 'description':
                self.desc = a.get('content') or ''
            if name == 'robots' and 'noindex' in (a.get('content') or '').lower():
                self.noindex = True
        elif tag == 'title':
            self._in_title = True
        elif tag == 'main':
            self._in_main += 1
        elif self._in_main:
            if tag in self.SKIP_TAGS or 'hidden' in a:
                self._skip += 1
            elif tag in ('h1', 'h2', 'h3') and not self._skip:
                self._head = []

    def handle_endtag(self, tag):
        if tag == 'title':
            self._in_title = False
        elif tag == 'main':
            self._in_main = max(0, self._in_main - 1)
        elif self._in_main:
            if tag in self.SKIP_TAGS and self._skip:
                self._skip -= 1
            elif tag in ('h1', 'h2', 'h3') and self._head is not None:
                h = ' '.join(''.join(self._head).split())
                if h:
                    self.heads.append(h)
                self._head = None

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif self._in_main and not self._skip:
            if self._head is not None:
                self._head.append(data)
            else:
                self.text.append(data)


def section(url):
    return next(label for prefix, label in SECTIONS if url.startswith(prefix))


def build():
    entries = []
    for f in sorted(DOCS.rglob('index.html')):
        url = '/' + str(f.parent.relative_to(DOCS)).replace('\\', '/') + '/'
        url = '/' if url == '/./' else url
        if any(url.startswith(s) for s in SKIP):
            continue
        p = Page()
        p.feed(f.read_text(encoding='utf-8', errors='replace'))
        if p.noindex or not p.title.strip():
            continue
        title = re.sub(r'\s+[—|-]\s+Pawan Sinha.*$', '', ' '.join(p.title.split()))
        text = ' '.join(' '.join(p.text).split())[:TEXT_CHARS]
        entries.append({'u': url, 't': title, 'd': p.desc.strip(), 's': section(url),
                        'h': [h for h in p.heads if h != title][:30], 'x': text})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(entries, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'indexed {len(entries)} pages, {OUT.stat().st_size // 1024} KB -> {OUT.relative_to(ROOT)}')


if __name__ == '__main__':
    build()
