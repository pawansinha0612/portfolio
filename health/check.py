"""Weekly site health check: finds what is about to break before it does.

Run by .github/workflows/site-health.yml. Prints a Markdown report and writes the problems to
health-problems.md (empty when all is well), which the workflow turns into a GitHub issue.

Checks:
  - key pages and the RSS feed load, and the HTTPS certificate isn't close to expiry
  - SECRETS_ADMIN_TOKEN still works and isn't close to expiry (needed to renew the LinkedIn token)
  - the LinkedIn token works, its expiry date, and the age of the LinkedIn API version
  - the AI key used for the weekly blog drafts still works
  - enough blog posts are scheduled, and no drafts pull request is waiting too long
  - the enquiry form backend (Google Apps Script) answers
  - the repository has had a commit recently (GitHub pauses schedules after 60 quiet days)

Environment (all optional; a check is skipped when its value is missing):
  ADMIN_TOKEN, LINKEDIN_ACCESS_TOKEN, LINKEDIN_TOKEN_EXPIRES, LINKEDIN_VERSION,
  AI_API_KEY, AI_BASE_URL, GITHUB_TOKEN, GITHUB_REPOSITORY
"""
import datetime as dt
import json
import os
import pathlib
import re
import socket
import ssl
import urllib.error
import urllib.request

SITE = 'pawansinha.com.au'
PAGES = ['/', '/blog/', '/blog/feed.xml', '/services/performance-testing/', '/shop/', '/perf-advisor/',
         '/peak-readiness/', '/hire/', '/portfolio-template/', '/tools/']
ROOT = pathlib.Path(__file__).resolve().parent.parent
TODAY = dt.date.today()
MIN_QUEUED_POSTS = 3

problems, report = [], []


def ok(msg):
    report.append(f'- ✅ {msg}')


def bad(msg, fix):
    report.append(f'- ❌ {msg}')
    problems.append(f'### {msg}\n{fix}\n')


def skip(msg):
    report.append(f'- ⏭️ {msg}')


def get(url, headers=None, timeout=20):
    """Returns (status, headers, body). Status 0 means the request didn't get an answer."""
    req = urllib.request.Request(url, headers={'User-Agent': 'site-health-check', **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, res.headers, res.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()
    except Exception as e:  # DNS, timeout, TLS
        return 0, {}, str(e).encode()


def days_until(date_text):
    return (dt.date.fromisoformat(date_text[:10]) - TODAY).days


def check_pages():
    failed = []
    for path in PAGES:
        status, _, _ = get(f'https://{SITE}{path}')
        if status != 200:
            failed.append(f'{path} ({status or "no answer"})')
    if failed:
        bad(f'{len(failed)} page(s) not loading: {", ".join(failed)}',
            'Open the repository **Actions** tab and check the latest **pages build and deployment** run. '
            'If it failed, re-run it. If the whole site is down, check **Settings → Pages** still shows your domain.')
    else:
        ok(f'All {len(PAGES)} key pages load')


def check_certificate():
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((SITE, 443), timeout=15) as sock:
            with ctx.wrap_socket(sock, server_hostname=SITE) as tls:
                expires = dt.datetime.strptime(tls.getpeercert()['notAfter'], '%b %d %H:%M:%S %Y %Z').date()
        left = (expires - TODAY).days
        if left < 14:
            bad(f'HTTPS certificate expires in {left} days',
                'GitHub renews it automatically, so this usually means the domain check is failing. '
                'Open **Settings → Pages**: the custom domain should show a green tick and **Enforce HTTPS** ticked. '
                'If not, check the domain\'s DNS records at Hostinger (four A records to 185.199.108–111.153).')
        else:
            ok(f'HTTPS certificate valid for {left} more days (GitHub renews it automatically)')
    except Exception as e:
        bad(f'HTTPS certificate could not be checked ({e})', 'Open the site in a browser and check for a certificate warning.')


def check_admin_token():
    token = os.environ.get('ADMIN_TOKEN', '').strip()
    repo = os.environ.get('GITHUB_REPOSITORY', 'pawansinha0612/portfolio')
    if not token:
        return skip('SECRETS_ADMIN_TOKEN not available to this check')
    status, headers, _ = get(f'https://api.github.com/repos/{repo}/actions/secrets/public-key',
                             {'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json'})
    fix = ('This token lets the **LinkedIn token** workflow save the renewed LinkedIn token. Make a new one: '
           'github.com/settings/personal-access-tokens → **Generate new token** (fine-grained), repository '
           '**portfolio** only, permissions **Secrets: Read and write** and **Variables: Read and write**, '
           'expiry **1 year** (or the longest offered). Then repository **Settings → Secrets and variables → Actions** '
           '→ **SECRETS_ADMIN_TOKEN** → Update, and paste it there (never in a chat or an issue).')
    if status != 200:
        return bad(f'SECRETS_ADMIN_TOKEN no longer works (HTTP {status or "no answer"})', fix)
    expiry = headers.get('github-authentication-token-expiration')
    if not expiry:
        return ok('SECRETS_ADMIN_TOKEN works and has no expiry date')
    left = days_until(expiry)
    if left < 30:
        bad(f'SECRETS_ADMIN_TOKEN expires in {left} days ({expiry[:10]})', fix)
    else:
        ok(f'SECRETS_ADMIN_TOKEN works, expires {expiry[:10]} ({left} days)')


def check_linkedin():
    token = os.environ.get('LINKEDIN_ACCESS_TOKEN', '').strip()
    expires = os.environ.get('LINKEDIN_TOKEN_EXPIRES', '').strip()
    renew = ('Actions → **LinkedIn token** → Run workflow with the code empty, open the sign-in link in the run summary, '
             'approve, then run it again with the code from the page you land on. Works from a phone.')
    if not token:
        skip('LinkedIn token not set')
    else:
        status, _, _ = get('https://api.linkedin.com/v2/userinfo', {'Authorization': f'Bearer {token}'})
        if status == 200:
            ok('LinkedIn token works')
        elif status == 401:
            bad('LinkedIn token has expired or was revoked', renew)
        else:
            report.append(f'- ⚠️ LinkedIn token test gave HTTP {status or "no answer"} (not necessarily a problem)')
    if expires:
        left = days_until(expires)
        if left < 14:
            bad(f'LinkedIn token expires in {left} days ({expires})', renew)
        else:
            ok(f'LinkedIn token expires {expires} ({left} days). Renewal reminder issue opens 7 days before')
    version = os.environ.get('LINKEDIN_VERSION', '').strip()
    if not version:
        src = (ROOT / 'blog' / 'linkedin.py').read_text()
        m = re.search(r"LINKEDIN_VERSION'\) or '(\d{6})'", src)
        version = m.group(1) if m else ''
    if version:
        age = (TODAY.year - int(version[:4])) * 12 + TODAY.month - int(version[4:])
        if age >= 10:
            bad(f'LinkedIn API version {version} is {age} months old',
                'LinkedIn retires API versions after about a year (posting then fails with HTTP 426). '
                'Repository **Settings → Secrets and variables → Actions → Variables** → set **LINKEDIN_VERSION** '
                f'to a recent month, for example {TODAY.year}{TODAY.month:02d} minus one or two months, as YYYYMM.')
        else:
            ok(f'LinkedIn API version {version} ({age} month(s) old; renew at about 10 months)')


def check_ai_key():
    key = os.environ.get('AI_API_KEY', '').strip()
    base = (os.environ.get('AI_BASE_URL') or 'https://integrate.api.nvidia.com/v1').rstrip('/')
    if not key:
        return skip('AI key not set')
    status, _, _ = get(f'{base}/models', {'Authorization': f'Bearer {key}'})
    if status == 200:
        ok('AI key for blog drafts works')
    elif status in (401, 403):
        bad(f'AI key for blog drafts is rejected (HTTP {status})',
            'Sign in at build.nvidia.com, create a new API key, then update the repository secret **AI_API_KEY**. '
            'Until then the Saturday drafts pull request won\'t appear, but scheduled posts keep publishing.')
    else:
        report.append(f'- ⚠️ AI key test gave HTTP {status or "no answer"} (the provider may be busy)')


def check_blog_queue():
    dates = []
    for f in (ROOT / 'blog' / 'posts').glob('*.md'):
        m = re.search(r'^date:\s*(\d{4}-\d{2}-\d{2})', f.read_text(), re.M)
        if m:
            dates.append(dt.date.fromisoformat(m.group(1)))
    queued = sorted(d for d in dates if d > TODAY)
    if len(queued) < MIN_QUEUED_POSTS:
        last = queued[-1].isoformat() if queued else 'today'
        bad(f'Only {len(queued)} blog post(s) scheduled (last one {last})',
            'Merge the open **Blog drafts for review** pull request (ask Claude to fact-check it first), or run '
            'Actions → **Blog drafts** → Run workflow. When posts run out, the site stops changing, and after 60 '
            'days without commits GitHub pauses the scheduled workflows.')
    else:
        ok(f'{len(queued)} blog posts scheduled, up to {queued[-1].isoformat()}')


def check_drafts_pr():
    token = os.environ.get('GITHUB_TOKEN', '').strip()
    repo = os.environ.get('GITHUB_REPOSITORY', '')
    if not (token and repo):
        return skip('Pull requests not checked (no GitHub token)')
    status, _, body = get(f'https://api.github.com/repos/{repo}/pulls?state=open',
                          {'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json'})
    if status != 200:
        return skip(f'Pull requests not checked (HTTP {status})')
    stale = [p for p in json.loads(body)
             if (TODAY - dt.date.fromisoformat(p['created_at'][:10])).days > 7]
    if stale:
        bad(f'{len(stale)} pull request(s) waiting more than a week: ' + ', '.join(f'#{p["number"]}' for p in stale),
            'Review and merge (or close) them. Blog drafts only go live once their pull request is merged.')
    else:
        ok('No pull requests waiting more than a week')


def check_form_backend():
    html = (ROOT / 'docs' / 'index.html').read_text()
    m = re.search(r'id="enquiry"[^>]*data-endpoint="([^"]+)"', html)
    if not m:
        return skip('Enquiry form endpoint not set')
    status, _, body = get(m.group(1) + '?view=testimonials')
    try:
        json.loads(body)
        good = status == 200
    except ValueError:
        good = False
    if good:
        ok('Enquiry form backend (Google Apps Script) answers')
    else:
        bad('Enquiry form backend (Google Apps Script) is not answering',
            'Open the **Website enquiries** Google Sheet → Extensions → Apps Script. Run any function once to see if '
            'Google asks you to approve permissions again, then Deploy → Manage deployments → check the web app is '
            'still deployed. Until fixed, the contact form, chat and checklist sign-ups don\'t reach you.')


def check_activity():
    token = os.environ.get('GITHUB_TOKEN', '').strip()
    repo = os.environ.get('GITHUB_REPOSITORY', '')
    if not (token and repo):
        return skip('Repository activity not checked')
    status, _, body = get(f'https://api.github.com/repos/{repo}/commits?per_page=1',
                          {'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json'})
    if status != 200:
        return skip(f'Repository activity not checked (HTTP {status})')
    last = dt.date.fromisoformat(json.loads(body)[0]['commit']['committer']['date'][:10])
    quiet = (TODAY - last).days
    if quiet > 40:
        bad(f'No commits for {quiet} days',
            'GitHub pauses scheduled workflows after 60 days without activity. Merge a blog drafts pull request, '
            'or make any small edit on GitHub (for example tick a box in README.md). If workflows were already '
            'paused, open Actions, pick each workflow and click **Enable workflow**.')
    else:
        ok(f'Last commit {quiet} day(s) ago')


for check in (check_pages, check_certificate, check_admin_token, check_linkedin, check_ai_key,
              check_blog_queue, check_drafts_pr, check_form_backend, check_activity):
    try:
        check()
    except Exception as e:
        report.append(f'- ⚠️ {check.__name__} could not run: {e}')

summary = f'## Site health, {TODAY.isoformat()}\n\n' + '\n'.join(report) + '\n'
print(summary)
if os.environ.get('GITHUB_STEP_SUMMARY'):
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as f:
        f.write(summary)
pathlib.Path('health-problems.md').write_text(
    ('\n'.join(problems) + '\n---\n' + summary) if problems else '')
