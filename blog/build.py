"""Build the blog from blog/posts/*.md into docs/blog/.

A post goes live once its `date` (Melbourne time) is today or earlier, so merged drafts publish one a day.

    pip install markdown pillow   # pillow makes the per-post share images (blog/og.py)
    python3 blog/build.py                  # what the daily GitHub Action runs
    python3 blog/build.py --include-future # preview every post locally (don't commit the output)

Post format (front matter between --- lines, then Markdown):

    ---
    title: Why p95 beats the average
    date: 2026-11-03
    summary: One or two sentences for the blog list, search results and link previews.
    tags: Performance, Metrics
    highlight: p95            (optional: title word(s) coloured on the share image; default is the last word)
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

try:  # per-post share images need Pillow; without it every post uses the site's default image
    import og
except ImportError:
    og = None

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
        'highlight': meta.get('highlight', ''),  # optional word(s) of the title to colour on the share image
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
  <meta property="og:image" content="{image}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:image" content="{image}">
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
    .post-sub {{ max-width: 720px; margin: 0 16px; }}
    .post-sub .subscribe {{ margin: 0 0 64px; }}
    .blog-index-sub {{ max-width: 800px; padding: 0 16px; }}
    .blog-index-sub .subscribe {{ margin: 0 0 64px; }}
    @media (max-width: 600px) {{ .blog-hero {{ padding-top: 40px; }} .article {{ font-size: 16px; }} }}
  </style>
</head>
<body>
  <header class="nav">
    <div class="wrap nav-inner">
      <a class="brand" href="/"><span class="logo" aria-hidden="true"></span>Pawan Sinha</a>
      <nav id="site-menu" aria-label="Main">
        <a href="/#services">Services</a>
        <a href="/#work">Work</a>
        <a href="/#resources">Resources</a>
        <a href="/blog/" aria-current="page">Blog</a>
        <a href="/#contact" class="btn btn-small">Hire me</a>
      </nav>
      <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-menu" aria-label="Open menu"><span></span></button>
    </div>
  </header>
  <main class="wrap" style="padding: 0;">
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
        <a href="/#contact">Book a free call</a>
      </div>
      <div>
        <h2>Free resources</h2>
        <a href="/interview-prep/performance-testing/">Interview prep</a>
        <a href="/tools/">Calculators</a>
        <a href="/blog/">Blog</a>
        <a href="/blog/feed.xml">RSS feed</a>
      </div>
      <div>
        <h2>Built by me</h2>
        <a href="/#projects">Projects</a>
        <a href="/projects/deal-finder/">Melbourne Deal Finder</a>
        <a href="/portfolio-template/">Portfolio Website Template</a>
      </div>
    </div>
    <div class="wrap footer-bottom">
      <p>© {year} Pawan Sinha · QA &amp; Test Automation Engineer</p>
      <p>ABN 43 627 514 346</p>
    </div>
  </footer>
  <script src="/chat.js" data-mode="services" data-endpoint="https://script.google.com/macros/s/AKfycbzvFENGzJ59oV9fx3Vc6CFzkjVpv5uFCx3Ob4zp_gfw0tNCXCI8TQYwJ9zQfkHQrARF/exec" data-booking-url="https://calendly.com/pawansinha4u/30min" defer></script>
  <script src="/subscribe.js" defer></script>
  <script src="/glow.js" defer></script>
  <script src="/menu.js" defer></script>
</body>
</html>
'''

e = html.escape

# Weekly digest signup. Hidden until the Apps Script backend says it can take signups (docs/subscribe.js).
SUBSCRIBE = '''<form class="subscribe" data-endpoint="https://script.google.com/macros/s/AKfycbzvFENGzJ59oV9fx3Vc6CFzkjVpv5uFCx3Ob4zp_gfw0tNCXCI8TQYwJ9zQfkHQrARF/exec" hidden novalidate>
        <div class="sub-text">
          <h2>One performance deep dive a week</h2>
          <p>Every Sunday: the week's posts and new calculators in one short email. Unsubscribe any time.</p>
        </div>
        <div class="sub-row">
          <input type="email" name="email" required maxlength="200" placeholder="you@company.com" aria-label="Email address" autocomplete="email">
          <button class="btn" type="submit">Subscribe</button>
        </div>
        <label class="hp" aria-hidden="true">Leave this empty<input name="company_site" tabindex="-1" autocomplete="off"></label>
        <p class="sub-status" role="status" aria-live="polite"></p>
      </form>'''


def tags_html(tags):
    return '<div class="tags">' + ''.join(f'<span class="tag">{e(t)}</span>' for t in tags) + '</div>' if tags else ''


def page(title, desc, page_url, og_type, body, image=None):
    return (HEAD.format(title=e(title), desc=e(desc), url=page_url, og_type=og_type, site=SITE,
                        image=image or SITE + '/og-image.png')
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
      <a class="btn btn-ghost btn-small" href="/tools/">Performance calculators</a>
    </aside>
    <aside class="post-sub">
      {SUBSCRIBE}
    </aside>
    <script type="application/ld+json">{ld}</script>
{widgets}'''
    image = url(p) + 'og.png' if (OUT / p['slug'] / 'og.png').exists() else None
    return page(p['title'] + ' — Pawan Sinha', p['summary'], url(p), 'article', body, image)


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
      <h1>Performance engineering, in depth</h1>
      <p class="lead">Deep dives on performance engineering: bottlenecks, load testing, caching, databases, load balancers, cloud and capacity planning. Most posts come with an interactive calculator. A new one every day.</p>
    </section>
    <section class="post-list">
{cards}
    </section>
    <section class="blog-index-sub">
      {SUBSCRIBE}
    </section>
'''
    return page('Blog — Pawan Sinha', 'Deep dives on performance engineering, load testing and capacity planning, with interactive calculators.',
                SITE + '/blog/', 'website', body)


def feed(posts):
    items = '\n'.join(f'''    <item>
      <title>{e(p["title"])}</title>
      <link>{url(p)}</link>
      <guid>{url(p)}</guid>
      <pubDate>{format_datetime(dt.datetime.combine(p["date"], dt.time(8), TZ))}</pubDate>
      <description>{e(p["summary"])}</description>
    </item>''' for p in posts[:30])
    # feed.xsl makes the feed readable when someone opens it in a browser instead of a feed reader.
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="/blog/feed.xsl"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Pawan Sinha — Blog</title>
    <link>{SITE}/blog/</link>
    <atom:link href="{SITE}/blog/feed.xml" rel="self" type="application/rss+xml"/>
    <description>Deep dives on performance engineering, load testing and capacity planning.</description>
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
        if og:
            og.save(p, OUT / p['slug'] / 'og.png')
        (OUT / p['slug'] / 'index.html').write_text(post_page(p), encoding='utf-8')
    (OUT / 'index.html').write_text(index_page(posts), encoding='utf-8')
    (OUT / 'feed.xml').write_text(feed(posts), encoding='utf-8')
    if not args.include_future:
        update_sitemap(posts)
    print(f'Built {len(posts)} post(s) into docs/blog/')


if __name__ == '__main__':
    main()
