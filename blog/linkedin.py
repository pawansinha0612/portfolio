"""Share today's blog post on LinkedIn (run by the daily GitHub Action after the blog is built).

Posts at most one article per run: the newest published post from the last 3 days that hasn't been shared yet.
Shared posts are recorded in blog/linkedin-posted.json so nothing is posted twice.

Environment (GitHub secrets/variables):
    LINKEDIN_ACCESS_TOKEN    set by the "LinkedIn token" workflow (lasts 60 days). If empty, this script does nothing.
    LINKEDIN_AUTHOR          optional, urn:li:person:... (looked up from the token if empty)
    LINKEDIN_TOKEN_EXPIRES   optional, YYYY-MM-DD; a warning issue is opened 7 days before
    LINKEDIN_VERSION         optional, LinkedIn API version YYYYMM (default below)

Writes token_problem=expired|expiring to $GITHUB_OUTPUT so the workflow can open a reminder issue.
"""
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build import load, today, url  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
POSTED = ROOT / 'blog' / 'linkedin-posted.json'
TOKEN = os.environ.get('LINKEDIN_ACCESS_TOKEN', '').strip()
VERSION = os.environ.get('LINKEDIN_VERSION') or '202609'


def output(key, value):
    path = os.environ.get('GITHUB_OUTPUT')
    if path:
        with open(path, 'a') as f:
            f.write(f'{key}={value}\n')


def api(method, path, body=None, rest=True):
    headers = {'Authorization': f'Bearer {TOKEN}'}
    if rest:
        headers.update({'LinkedIn-Version': VERSION, 'X-Restli-Protocol-Version': '2.0.0'})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request('https://api.linkedin.com' + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            text = r.read().decode() or '{}'
            return r.status, dict(r.headers), json.loads(text)
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors='replace')[:500]
        if err.code == 401:
            output('token_problem', 'expired')
            raise SystemExit('LinkedIn says the access token is invalid or expired. Run the "LinkedIn token" workflow for a new one.')
        raise SystemExit(f'LinkedIn API error: HTTP {err.code} {detail}')


def little_text(text):
    """Escape LinkedIn's reserved characters so the post isn't cut short; keep #hashtags clickable."""
    out = []
    for part in re.split(r'(#\w+)', text):
        if re.fullmatch(r'#\w+', part):
            out.append('{hashtag|\\#|' + part[1:] + '}')
        else:
            out.append(re.sub(r'([\\|{}@\[\]()<>#*_~])', r'\\\1', part))
    return ''.join(out)


def wait_until_live(page_url, minutes=10):
    deadline = time.time() + minutes * 60
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(urllib.request.Request(page_url, method='HEAD'), timeout=20) as r:
                if r.status == 200:
                    return True
        except urllib.error.URLError:
            pass
        print('  waiting for the page to go live…')
        time.sleep(30)
    return False


def check_expiry():
    exp = os.environ.get('LINKEDIN_TOKEN_EXPIRES', '').strip()
    if not exp:
        return
    days = (dt.date.fromisoformat(exp) - today()).days
    if days <= 7:
        print(f'::warning::The LinkedIn token expires in {days} day(s) ({exp}). Run the "LinkedIn token" workflow.')
        output('token_problem', 'expiring')


def main():
    if not TOKEN:
        print('LINKEDIN_ACCESS_TOKEN not set; skipping LinkedIn.')
        return
    check_expiry()

    posted = json.loads(POSTED.read_text()) if POSTED.exists() else {}
    recent = [p for p in load() if p['slug'] not in posted and p['date'] >= today() - dt.timedelta(days=3)]
    if not recent:
        print('Nothing new to share on LinkedIn.')
        return
    post = recent[0]  # load() is newest first

    if not wait_until_live(url(post)):
        raise SystemExit(f'{url(post)} is not live yet; it will be shared on the next run.')

    author = os.environ.get('LINKEDIN_AUTHOR', '').strip()
    if not author:
        _, _, me = api('GET', '/v2/userinfo', rest=False)
        author = f'urn:li:person:{me["sub"]}'

    _, headers, _ = api('POST', '/rest/posts', {
        'author': author,
        'commentary': little_text(post['linkedin'] or post['summary']),
        'visibility': 'PUBLIC',
        'distribution': {'feedDistribution': 'MAIN_FEED', 'targetEntities': [], 'thirdPartyDistributionChannels': []},
        'content': {'article': {'source': url(post), 'title': post['title'], 'description': post['summary']}},
        'lifecycleState': 'PUBLISHED',
        'isReshareDisabledByAuthor': False,
    })
    share = headers.get('x-restli-id') or headers.get('X-RestLi-Id') or 'posted'
    posted[post['slug']] = {'date': today().isoformat(), 'id': share}
    POSTED.write_text(json.dumps(posted, indent=2) + '\n')
    print(f'Shared on LinkedIn: {post["title"]} ({share})')


if __name__ == '__main__':
    main()
