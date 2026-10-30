"""Share today's blog post on LinkedIn (run by the daily GitHub Action after the blog is built).

Posts at most one article per run: the newest published post from the last 3 days that hasn't been shared yet.
Shared posts are recorded in blog/linkedin-posted.json so nothing is posted twice.

Environment (GitHub secrets/variables):
    LINKEDIN_ACCESS_TOKEN    set by the "LinkedIn token" workflow (lasts 60 days). If empty, this script does nothing.
    LINKEDIN_AUTHOR          optional, urn:li:person:... (looked up from the token if empty)
    LINKEDIN_TOKEN_EXPIRES   optional, YYYY-MM-DD; a warning issue is opened 7 days before
    LINKEDIN_VERSION         optional, LinkedIn API version YYYYMM (default below)

Company page (optional, needs LinkedIn's Community Management API on a separate app):
    LINKEDIN_PAGE_ACCESS_TOKEN   set by the "LinkedIn token" workflow with account = page. If empty, the page is skipped.
    LINKEDIN_PAGE_URN            urn:li:organization:<page id> (the number in the page's admin URL)
    LINKEDIN_PAGE_TOKEN_EXPIRES  optional, YYYY-MM-DD

Writes token_problem / page_token_problem = expired|expiring to $GITHUB_OUTPUT so the workflow can open a reminder issue.
A page failure never stops the personal share.
"""
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build import load, today, url  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
POSTED = ROOT / 'blog' / 'linkedin-posted.json'
TOKEN = os.environ.get('LINKEDIN_ACCESS_TOKEN', '').strip()
PAGE_TOKEN = os.environ.get('LINKEDIN_PAGE_ACCESS_TOKEN', '').strip()
PAGE_URN = os.environ.get('LINKEDIN_PAGE_URN', '').strip()
VERSION = os.environ.get('LINKEDIN_VERSION') or '202609'


def output(key, value):
    path = os.environ.get('GITHUB_OUTPUT')
    if path:
        with open(path, 'a') as f:
            f.write(f'{key}={value}\n')


class ApiError(Exception):
    def __init__(self, code, detail):
        super().__init__(f'HTTP {code} {detail}')
        self.code = code


def api(method, path, body=None, rest=True, token=None):
    headers = {'Authorization': f'Bearer {token or TOKEN}'}
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
        raise ApiError(err.code, err.read().decode(errors='replace')[:500])


def upload_thumbnail(owner, post, token=None):
    """Upload the post's share image (docs/blog/<slug>/og.png from build.py); returns an image URN or None."""
    path = ROOT / 'docs' / 'blog' / post['slug'] / 'og.png'
    if not path.exists():
        return None
    _, _, res = api('POST', '/rest/images?action=initializeUpload',
                    {'initializeUploadRequest': {'owner': owner}}, token=token)
    upload_url, image = res['value']['uploadUrl'], res['value']['image']
    req = urllib.request.Request(upload_url, data=path.read_bytes(), method='PUT',
                                 headers={'Authorization': f'Bearer {token or TOKEN}'})
    urllib.request.urlopen(req, timeout=60).close()
    for _ in range(10):  # wait until LinkedIn has processed the upload
        try:
            _, _, info = api('GET', '/rest/images/' + urllib.parse.quote(image, safe=''), token=token)
            if info.get('status') == 'AVAILABLE':
                break
        except ApiError:
            pass
        time.sleep(3)
    return image


def share(author, post, token=None):
    """Publish the post's LinkedIn text with a link card (and its share image); returns the new post's id."""
    try:
        thumbnail = upload_thumbnail(author, post, token)
    except (ApiError, urllib.error.URLError, KeyError) as err:
        if getattr(err, 'code', None) == 401:
            raise
        print(f'::warning::Could not upload the share image ({err}); posting without it.')
        thumbnail = None
    article = {'source': url(post), 'title': post['title'], 'description': post['summary']}
    body = {
        'author': author,
        'commentary': little_text(post['linkedin'] or post['summary']),
        'visibility': 'PUBLIC',
        'distribution': {'feedDistribution': 'MAIN_FEED', 'targetEntities': [], 'thirdPartyDistributionChannels': []},
        'content': {'article': dict(article, thumbnail=thumbnail) if thumbnail else article},
        'lifecycleState': 'PUBLISHED',
        'isReshareDisabledByAuthor': False,
    }
    try:
        _, headers, _ = api('POST', '/rest/posts', body, token=token)
    except ApiError as err:
        if not thumbnail or err.code == 401:
            raise
        print(f'::warning::LinkedIn refused the post with the image ({err}); posting without it.')
        body['content'] = {'article': article}
        _, headers, _ = api('POST', '/rest/posts', body, token=token)
    return headers.get('x-restli-id') or headers.get('X-RestLi-Id') or 'posted'


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


def check_expiry(var, problem_key, workflow_hint):
    exp = os.environ.get(var, '').strip()
    if not exp:
        return
    days = (dt.date.fromisoformat(exp) - today()).days
    if days <= 7:
        print(f'::warning::{workflow_hint} expires in {days} day(s) ({exp}). Run the "LinkedIn token" workflow.')
        output(problem_key, 'expiring')


def share_personal(posted):
    recent = [p for p in load() if p['slug'] not in posted and p['date'] >= today() - dt.timedelta(days=3)]
    if not recent:
        print('Nothing new to share on your profile.')
        return
    post = recent[0]  # load() is newest first
    if not wait_until_live(url(post)):
        raise SystemExit(f'{url(post)} is not live yet; it will be shared on the next run.')

    author = os.environ.get('LINKEDIN_AUTHOR', '').strip()
    try:
        if not author:
            _, _, me = api('GET', '/v2/userinfo', rest=False)
            author = f'urn:li:person:{me["sub"]}'
        post_id = share(author, post)
    except ApiError as err:
        if err.code == 401:
            output('token_problem', 'expired')
            raise SystemExit('LinkedIn says the access token is invalid or expired. Run the "LinkedIn token" workflow.')
        raise SystemExit(f'LinkedIn API error: {err}')
    posted[post['slug']] = {'date': today().isoformat(), 'id': post_id}
    save(posted)
    print(f'Shared on your LinkedIn profile: {post["title"]} ({post_id})')


def share_page(posted):
    if not PAGE_TOKEN or not PAGE_URN:
        print('Company page not connected (LINKEDIN_PAGE_ACCESS_TOKEN / LINKEDIN_PAGE_URN); skipping the page.')
        return
    check_expiry('LINKEDIN_PAGE_TOKEN_EXPIRES', 'page_token_problem', 'The LinkedIn company page token')
    # The newest post already on the profile but not yet on the page.
    todo = [p for p in load() if p['slug'] in posted and 'page_id' not in posted[p['slug']]
            and p['date'] >= today() - dt.timedelta(days=3)]
    if not todo:
        print('Nothing new to share on the company page.')
        return
    post = todo[0]
    try:
        post_id = share(PAGE_URN, post, token=PAGE_TOKEN)
    except ApiError as err:
        if err.code == 401:
            output('page_token_problem', 'expired')
        print(f'::warning::Company page share failed ({err}). The profile share is unaffected.')
        return
    posted[post['slug']]['page_id'] = post_id
    save(posted)
    print(f'Shared on the company page: {post["title"]} ({post_id})')


def save(posted):
    POSTED.write_text(json.dumps(posted, indent=2) + '\n')


def main():
    posted = json.loads(POSTED.read_text()) if POSTED.exists() else {}
    if TOKEN:
        check_expiry('LINKEDIN_TOKEN_EXPIRES', 'token_problem', 'The LinkedIn token')
        share_personal(posted)
    else:
        print('LINKEDIN_ACCESS_TOKEN not set; skipping your profile.')
    share_page(posted)


if __name__ == '__main__':
    main()
