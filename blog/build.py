"""Build the blog from blog/posts/*.md into docs/blog/.

A post goes live once its `date` (Melbourne time) is today or earlier, so merged drafts publish one a day.

    pip install markdown
    python3 blog/build.py                  # what the daily GitHub Action runs
    python3 blog/build.py --include-future # preview every post locally (don't commit the output)

Post format (front matter between --- lines, then Markdown):

    ---
    title: Why p95 beats the average
    date: 2026-11-03
    summary: One or two sentences for the blog list, search results and link previews.
    tags: Performance, Metrics
    linkedin: |
      The LinkedIn post text (no link: the post card links to the article).
    ---
    Body in Markdown...
"""
import argparse
import datetime as dt
import html
import json
import re
from email.utils import format_datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import markdown

ROOT = Path(__file__).resolve().parent.parent
POSTS = ROOT / 'blog' / 'posts'
OUT = ROOT / 'docs' / 'blog'
SITEMAP = ROOT / 'docs' / 'sitemap.xml'
SITE = 'https://pawansinha.com.au'
TZ = ZoneInfo('Australia/Melbourne')


def today():
    return dt.datetime.now(TZ).date()


def parse(path):
    text = path.read_text(encoding='utf-8')
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        raise SystemExit(f'{path.name}: missing front matter')
    meta, key = {}, None
    for line in m.group(1).split('\n'):
        if key and (line.startswith('  ') or not line.strip()):
            meta[key] += line[2:] + '\n'
            continue
        key = None
        k, _, v = line.partition(':')
        k, v = k.strip(), v.strip()
        if v == '|':
            key, meta[k] = k, ''
        elif k:
            meta[k] = v
    for need in ('title', 'date', 'summary'):
        if not meta.get(need):
            raise SystemExit(f'{path.name}: front matter needs "{need}"')
    slug = re.sub(r'^\d{4}-\d{2}-\d{2}-', '', path.stem)
    return {
        'slug': slug,
        'title': meta['title'],
        'date': dt.date.fromisoformat(meta['date']),
        'summary': meta['summary'],
        'tags': [t.strip() for t in meta.get('tags', '').split(',') if t.strip()],
        'linkedin': meta.get('linkedin', '').strip(),
        'body': markdown.markdown(m.group(2), extensions=['fenced_code', 'tables', 'sane_lists']),
        'words': len(m.group(2).split()),
    }


def load(include_future=False):
    posts = [parse(p) for p in sorted(POSTS.glob('*.md'))]
    if not include_future:
        posts = [p for p in posts if p['date'] <= today()]
    seen = set()
    for p in posts:
        if p['slug'] in seen:
            raise SystemExit(f'Two posts share the slug "{p["slug"]}"')
        seen.add(p['slug'])
    return sorted(posts, key=lambda p: p['date'], reverse=True)


def url(p):
    return f'{SITE}/blog/{p["slug"]}/'


def nice_date(d):
    return f'{d.day} {d.strftime("%B %Y")}'


HEAD = '''<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <meta name="description" content="{desc}">
  <meta property="og:title" content="{title}">
  <meta property="og:description" content="{desc}">
  <meta property="og:type" content="{og_type}">
  <meta property="og:url" content="{url}">
  <meta property="og:image" content="{site}/og-image.png">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="canonical" href="{url}">
  <link rel="alternate" type="application/rss+xml" title="Pawan Sinha's blog" href="{site}/blog/feed.xml">
  <meta name="theme-color" content="#2557d6">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%232557d6'/><path d='M7 22l6-7 5 4 7-10' stroke='white' stroke-width='3' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles.css">
  <link rel="stylesheet" href="/chat.css">
  <style>
    .blog-hero {{ padding: 64px 16px 24px; }}
    .blog-hero h1 {{ font-size: clamp(30px, 5vw, 46px); line-height: 1.12; margin: 0 0 14px; }}
    .post-meta {{ color: var(--muted); font-size: 14px; display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; }}
    .post-list {{ display: flex; flex-direction: column; gap: 14px; padding: 8px 16px 64px; max-width: 800px; }}
    .post-card {{ display: block; background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 20px 22px; text-decoration: none; color: var(--text); box-shadow: var(--shadow); }}
    .post-card:hover {{ border-color: var(--accent); }}
    .post-card h2 {{ font-size: 20px; margin: 6px 0 8px; line-height: 1.3; }}
    .post-card p {{ margin: 0 0 10px; color: var(--muted); }}
    .tags {{ display: flex; flex-wrap: wrap; gap: 6px; }}
    .article {{ max-width: 720px; padding: 0 16px 48px; font-size: 17px; line-height: 1.75; }}
    .article h2 {{ font-size: 24px; margin: 36px 0 10px; line-height: 1.3; }}
    .article h3 {{ font-size: 19px; margin: 28px 0 8px; }}
    .article p, .article ul, .article ol {{ margin: 0 0 16px; }}
    .article pre {{ background: var(--alt); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; overflow-x: auto; font: 500 13.5px/1.6 "JetBrains Mono", monospace; }}
    .article code {{ font: 500 14px "JetBrains Mono", monospace; background: var(--alt); padding: 1px 5px; border-radius: 5px; }}
    .article pre code {{ background: none; padding: 0; font-size: inherit; }}
    .article blockquote {{ margin: 0 0 16px; padding: 10px 16px; border-left: 3px solid var(--accent-2); background: var(--alt); border-radius: 0 10px 10px 0; }}
    .article table {{ border-collapse: collapse; width: 100%; margin: 0 0 16px; font-size: 15px; display: block; overflow-x: auto; }}
    .article th, .article td {{ border: 1px solid var(--border); padding: 8px 10px; text-align: left; }}
    .article th {{ background: var(--alt); }}
    .post-cta {{ max-width: 720px; margin: 0 16px 64px; background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 22px; }}
    .post-cta h2 {{ margin: 0 0 6px; font-size: 20px; }}
    .post-cta p {{ margin: 0 0 14px; color: var(--muted); }}
    .empty {{ color: var(--muted); }}
    @media (max-width: 600px) {{ .blog-hero {{ padding-top: 40px; }} .article {{ font-size: 16px; }} }}
  </style>
</head>
<body>
  <header class="nav">
    <div class="wrap nav-inner">
      <a class="brand" href="/"><span class="logo" aria-hidden="true"></span>Pawan Sinha</a>
      <nav>
        <a href="/blog/">Blog</a>
        <a href="/interview-prep/performance-testing/">Interview prep</a>
        <a href="/#contact" class="btn btn-small">Hire me</a>
      </nav>
    </div>
  </header>
  <main class="wrap" style="padding: 0;">
'''

FOOT = '''  </main>
  <footer class="footer wrap">
    <p>© {year} Pawan Sinha · QA &amp; Test Automation Engineer · Melbourne, Australia</p>
    <p><a href="/blog/feed.xml">RSS</a> · <a href="/">pawansinha.com.au</a></p>
  </footer>
  <script src="/chat.js" data-mode="services" data-endpoint="https://script.google.com/macros/s/AKfycbzvFENGzJ59oV9fx3Vc6CFzkjVpv5uFCx3Ob4zp_gfw0tNCXCI8TQYwJ9zQfkHQrARF/exec" data-booking-url="https://calendly.com/pawansinha4u/30min" defer></script>
  <script src="/glow.js" defer></script>
</body>
</html>
'''

e = html.escape


def tags_html(tags):
    return '<div class="tags">' + ''.join(f'<span class="tag">{e(t)}</span>' for t in tags) + '</div>' if tags else ''


def page(title, desc, page_url, og_type, body):
    return (HEAD.format(title=e(title), desc=e(desc), url=page_url, og_type=og_type, site=SITE)
            + body + FOOT.format(year=today().year))


def post_page(p):
    minutes = max(1, round(p['words'] / 220))
    ld = json.dumps({
        '@context': 'https://schema.org', '@type': 'BlogPosting', 'headline': p['title'],
        'description': p['summary'], 'datePublished': p['date'].isoformat(), 'url': url(p),
        'author': {'@type': 'Person', 'name': 'Pawan Sinha', 'url': SITE + '/'},
    })
    widgets = '    <script src="/widgets.js" defer></script>\n' if 'data-widget=' in p['body'] else ''  # interactive charts (docs/widgets.js)
    body = f'''    <article>
      <header class="blog-hero">
        <p class="eyebrow"><a href="/blog/" style="text-decoration:none">← Blog</a></p>
        <h1>{e(p["title"])}</h1>
        <div class="post-meta"><span>{nice_date(p["date"])}</span><span>{minutes} min read</span>{tags_html(p["tags"])}</div>
      </header>
      <div class="article">
{p["body"]}
      </div>
    </article>
    <aside class="post-cta">
      <h2>Need this done on your project?</h2>
      <p>I help teams with testing, automation and performance engineering. Tell me what you're working on.</p>
      <a class="btn btn-small" href="/#contact">Get in touch</a>
      <a class="btn btn-ghost btn-small" href="/interview-prep/performance-testing/">Interview prep questions</a>
    </aside>
    <script type="application/ld+json">{ld}</script>
{widgets}'''
    return page(p['title'] + ' — Pawan Sinha', p['summary'], url(p), 'article', body)


def index_page(posts):
    if posts:
        cards = '\n'.join(f'''      <a class="post-card" href="/blog/{p["slug"]}/">
        <div class="post-meta">{nice_date(p["date"])}</div>
        <h2>{e(p["title"])}</h2>
        <p>{e(p["summary"])}</p>
        {tags_html(p["tags"])}
      </a>''' for p in posts)
    else:
        cards = '      <p class="empty">The first post is on its way. Check back soon.</p>'
    body = f'''    <section class="blog-hero">
      <p class="eyebrow">Blog</p>
      <h1>Notes on testing, quality and performance</h1>
      <p class="lead">Practical posts on QA, test automation, API, mobile and performance testing, and using AI in testing. A new one most days.</p>
    </section>
    <section class="post-list">
{cards}
    </section>
'''
    return page('Blog — Pawan Sinha', 'Practical posts on QA, test automation, API, mobile and performance testing, and AI in testing.',
                SITE + '/blog/', 'website', body)


def feed(posts):
    items = '\n'.join(f'''    <item>
      <title>{e(p["title"])}</title>
      <link>{url(p)}</link>
      <guid>{url(p)}</guid>
      <pubDate>{format_datetime(dt.datetime.combine(p["date"], dt.time(8), TZ))}</pubDate>
      <description>{e(p["summary"])}</description>
    </item>''' for p in posts[:30])
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Pawan Sinha — Blog</title>
    <link>{SITE}/blog/</link>
    <description>Practical posts on QA, test automation and performance engineering.</description>
    <language>en-au</language>
{items}
  </channel>
</rss>
'''


def update_sitemap(posts):
    s = SITEMAP.read_text(encoding='utf-8')
    entries = [f'  <url><loc>{SITE}/blog/</loc><changefreq>daily</changefreq><priority>0.7</priority></url>']
    entries += [f'  <url><loc>{url(p)}</loc><lastmod>{p["date"].isoformat()}</lastmod><priority>0.6</priority></url>' for p in posts]
    block = '  <!-- blog:start (generated by blog/build.py) -->\n' + '\n'.join(entries) + '\n  <!-- blog:end -->'
    if '<!-- blog:start' in s:
        s = re.sub(r'  <!-- blog:start.*?<!-- blog:end -->', lambda _: block, s, flags=re.S)
    else:
        s = s.replace('</urlset>', block + '\n</urlset>')
    SITEMAP.write_text(s, encoding='utf-8')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--include-future', action='store_true', help='also build posts dated after today (local preview)')
    args = ap.parse_args()
    posts = load(args.include_future)
    OUT.mkdir(parents=True, exist_ok=True)
    live = {p['slug'] for p in posts}
    for d in OUT.iterdir():  # remove pages for posts that were deleted or renamed
        if d.is_dir() and d.name not in live:
            for f in d.iterdir():
                f.unlink()
            d.rmdir()
    for p in posts:
        (OUT / p['slug']).mkdir(exist_ok=True)
        (OUT / p['slug'] / 'index.html').write_text(post_page(p), encoding='utf-8')
    (OUT / 'index.html').write_text(index_page(posts), encoding='utf-8')
    (OUT / 'feed.xml').write_text(feed(posts), encoding='utf-8')
    if not args.include_future:
        update_sitemap(posts)
    print(f'Built {len(posts)} post(s) into docs/blog/')


if __name__ == '__main__':
    main()
