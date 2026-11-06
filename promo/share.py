"""Tool spotlight: share the next free-tool post from promo/tool-posts.md on LinkedIn.

Run by .github/workflows/tool-spotlight.yml (Tuesdays and Thursdays). Posts at most one per run: the first section
in tool-posts.md that isn't in promo/posted.json and isn't marked `skip: yes`. Uses the same LinkedIn token and
helpers as the blog (blog/linkedin.py), with docs/promo/<id>.png as the link card image.

    python3 promo/share.py --images    # (re)make docs/promo/<id>.png for every post (needs Pillow)
    python3 promo/share.py --dry-run   # show what would be posted next, post nothing
    python3 promo/share.py             # post the next one (needs LINKEDIN_ACCESS_TOKEN)
"""
import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POSTS = ROOT / 'promo' / 'tool-posts.md'
POSTED = ROOT / 'promo' / 'posted.json'
IMAGES = ROOT / 'docs' / 'promo'
LABEL = 'Free tool · runs in your browser'


def load():
    """Parse tool-posts.md into a list of dicts: id, url, title, highlight, description, text, skip."""
    text = POSTS.read_text(encoding='utf-8')
    posts = []
    for block in re.split(r'^## ', text, flags=re.M)[1:]:
        head, _, body = block.partition('\n')
        meta, _, post_text = body.strip('\n').partition('\n\n')
        item = {'id': head.strip(), 'text': post_text.strip()}
        for line in meta.splitlines():
            key, _, value = line.partition(':')
            item[key.strip().lower()] = value.strip()
        for key in ('url', 'title', 'description'):
            if not item.get(key):
                raise SystemExit(f'tool-posts.md: "{item["id"]}" is missing {key}:')
        if not item['text']:
            raise SystemExit(f'tool-posts.md: "{item["id"]}" has no post text')
        item['skip'] = item.get('skip', '').lower() in ('yes', 'true', '1')
        posts.append(item)
    ids = [p['id'] for p in posts]
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        raise SystemExit(f'tool-posts.md: duplicate ids {sorted(dupes)}')
    return posts


def image_path(post):
    return IMAGES / f'{post["id"]}.png'


def make_images(posts):
    sys.path.insert(0, str(ROOT / 'blog'))
    import og
    for p in posts:
        og.save({'title': p['title'], 'highlight': p.get('highlight', ''), 'label': p.get('label') or LABEL,
                 'tags': ['free tool', 'performance']}, image_path(p))
        print('wrote', image_path(p).relative_to(ROOT))


def posted():
    return json.loads(POSTED.read_text()) if POSTED.exists() else {}


def next_post(posts, done):
    return next((p for p in posts if p['id'] not in done and not p['skip']), None)


def page_is_live(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'tool-spotlight'}), timeout=30) as r:
            return r.status == 200
    except (urllib.error.URLError, TimeoutError):
        return False


def main():
    posts = load()
    if '--images' in sys.argv:
        make_images(posts)
        return
    done = posted()
    post = next_post(posts, done)
    if not post:
        print('Every tool post has been shared. Add more sections to promo/tool-posts.md.')
        return
    if '--dry-run' in sys.argv:
        print(f'Next: {post["id"]} -> {post["url"]}\nImage: {image_path(post).relative_to(ROOT)} '
              f'({"exists" if image_path(post).exists() else "MISSING"})\n\n{post["text"]}')
        return
    if not os.environ.get('LINKEDIN_ACCESS_TOKEN', '').strip():
        print('LINKEDIN_ACCESS_TOKEN not set; nothing posted.')
        return
    if not page_is_live(post['url']):
        raise SystemExit(f'{post["url"]} is not live (not 200); not posting it. Fix the page or mark it skip: yes.')

    sys.path.insert(0, str(ROOT / 'blog'))
    import linkedin as li
    li.check_expiry('LINKEDIN_TOKEN_EXPIRES', 'token_problem', 'The LinkedIn token')
    author = os.environ.get('LINKEDIN_AUTHOR', '').strip()
    try:
        if not author:
            _, _, me = li.api('GET', '/v2/userinfo', rest=False)
            author = f'urn:li:person:{me["sub"]}'
        thumbnail = None
        if image_path(post).exists():
            try:
                thumbnail = upload(li, author, image_path(post))
            except (li.ApiError, urllib.error.URLError, KeyError) as err:
                if getattr(err, 'code', None) == 401:
                    raise
                print(f'::warning::Could not upload the image ({err}); posting without it.')
        article = {'source': post['url'], 'title': post['title'], 'description': post['description']}
        body = {
            'author': author,
            'commentary': li.little_text(post['text']),
            'visibility': 'PUBLIC',
            'distribution': {'feedDistribution': 'MAIN_FEED', 'targetEntities': [], 'thirdPartyDistributionChannels': []},
            'content': {'article': dict(article, thumbnail=thumbnail) if thumbnail else article},
            'lifecycleState': 'PUBLISHED',
            'isReshareDisabledByAuthor': False,
        }
        _, headers, _ = li.api('POST', '/rest/posts', body)
    except li.ApiError as err:
        if err.code == 401:
            li.output('token_problem', 'expired')
            raise SystemExit('LinkedIn says the access token is invalid or expired. Run the "LinkedIn token" workflow.')
        raise SystemExit(f'LinkedIn API error: {err}')
    post_id = headers.get('x-restli-id') or headers.get('X-RestLi-Id') or 'posted'
    done[post['id']] = {'date': dt.date.today().isoformat(), 'id': post_id}
    POSTED.write_text(json.dumps(done, indent=1) + '\n')
    print(f'Shared tool spotlight: {post["id"]} ({post_id})')


def upload(li, owner, path):
    """Upload a PNG to LinkedIn's Images API and return its URN (same steps as blog/linkedin.py)."""
    import time
    import urllib.parse
    _, _, res = li.api('POST', '/rest/images?action=initializeUpload', {'initializeUploadRequest': {'owner': owner}})
    upload_url, image = res['value']['uploadUrl'], res['value']['image']
    req = urllib.request.Request(upload_url, data=path.read_bytes(), method='PUT',
                                 headers={'Authorization': f'Bearer {li.TOKEN}', 'Content-Type': 'application/octet-stream'})
    urllib.request.urlopen(req, timeout=60).close()
    for _ in range(10):
        try:
            _, _, info = li.api('GET', '/rest/images/' + urllib.parse.quote(image, safe=''))
            if info.get('status') == 'AVAILABLE':
                break
        except li.ApiError:
            pass
        time.sleep(3)
    return image


if __name__ == '__main__':
    main()
