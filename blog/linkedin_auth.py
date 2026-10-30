"""Get a LinkedIn access token for the blog's daily posting. Needed once, then every ~60 days.

Easiest (any computer or phone, nothing to install): GitHub → Actions → "LinkedIn token" → Run workflow
with the code box empty, open the sign-in link it shows, approve, copy the code from the page you land on,
then run the workflow again with that code. The workflow saves the new token into GitHub for you.

On your own computer instead:
    LINKEDIN_CLIENT_ID=xxx LINKEDIN_CLIENT_SECRET=yyy python3 blog/linkedin_auth.py
It opens LinkedIn, waits for the approval on http://localhost:8765/callback and prints the values to add in
GitHub (Settings → Secrets and variables → Actions).

Both redirect URLs must be listed in the LinkedIn app (Auth tab):
    https://pawansinha.com.au/linkedin-callback/
    http://localhost:8765/callback

Workflow modes (used by .github/workflows/linkedin-token.yml):
    python3 blog/linkedin_auth.py --link            print the sign-in link
    python3 blog/linkedin_auth.py --code CODE       exchange the code and save it to GitHub with the gh CLI
Add --page to either for the company page app (Community Management API, its own client ID and secret:
LINKEDIN_PAGE_CLIENT_ID / LINKEDIN_PAGE_CLIENT_SECRET). It saves LINKEDIN_PAGE_ACCESS_TOKEN instead.

Uses only the Python standard library.
"""
import argparse
import datetime as dt
import http.server
import json
import os
import secrets
import subprocess
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

CLIENT_ID = os.environ.get('LINKEDIN_CLIENT_ID', '').strip()
CLIENT_SECRET = os.environ.get('LINKEDIN_CLIENT_SECRET', '').strip()
LOCAL_REDIRECT = 'http://localhost:8765/callback'
WEB_REDIRECT = 'https://pawansinha.com.au/linkedin-callback/'
SCOPES = 'openid profile w_member_social'
PAGE_SCOPES = 'w_organization_social'
page_mode = False  # set by --page: use the company page app and save the page token


def auth_url(redirect, state):
    return 'https://www.linkedin.com/oauth/v2/authorization?' + urllib.parse.urlencode({
        'response_type': 'code', 'client_id': CLIENT_ID, 'redirect_uri': redirect, 'state': state,
        'scope': PAGE_SCOPES if page_mode else SCOPES,
    })


def exchange(code, redirect):
    """Swap a sign-in code for an access token; returns (token, expiry date, person URN, name)."""
    body = urllib.parse.urlencode({
        'grant_type': 'authorization_code', 'code': code, 'redirect_uri': redirect,
        'client_id': CLIENT_ID, 'client_secret': CLIENT_SECRET,
    }).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request('https://www.linkedin.com/oauth/v2/accessToken', data=body)) as r:
            token = json.load(r)
    except urllib.error.HTTPError as err:
        raise SystemExit(f'LinkedIn rejected the code (HTTP {err.code}): {err.read().decode(errors="replace")[:300]}\n'
                         'Codes work once and expire after a few minutes. Get a fresh one and try again.')
    access = token['access_token']
    expires = dt.date.today() + dt.timedelta(seconds=int(token.get('expires_in', 0)))
    if page_mode:  # the page app has no sign-in scopes, so there is no profile to look up
        return access, expires, None, 'your company page'
    req = urllib.request.Request('https://api.linkedin.com/v2/userinfo', headers={'Authorization': f'Bearer {access}'})
    with urllib.request.urlopen(req) as r:
        me = json.load(r)
    return access, expires, f'urn:li:person:{me["sub"]}', me.get('name', '?')


def local_flow():
    state = secrets.token_urlsafe(16)
    url = auth_url(LOCAL_REDIRECT, state)
    result = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            result.update({k: v[0] for k, v in q.items()})
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write('<h2>Done. You can close this tab and go back to the terminal.</h2>'.encode())

        def log_message(self, *args):
            pass

    print('Opening LinkedIn in your browser. If it does not open, visit:\n' + url)
    webbrowser.open(url)
    with http.server.HTTPServer(('localhost', 8765), Handler) as server:
        while 'code' not in result and 'error' not in result:
            server.handle_request()

    if 'error' in result:
        raise SystemExit(f'LinkedIn returned an error: {result.get("error")}: {result.get("error_description", "")}')
    if result.get('state') != state:
        raise SystemExit('State mismatch; please run the script again.')

    access, expires, author, name = exchange(result['code'], LOCAL_REDIRECT)
    print(f'''
Signed in as {name}. Add these in GitHub → your portfolio repo → Settings → Secrets and variables → Actions:

  Secret    LINKEDIN_ACCESS_TOKEN   = {access}
  Variable  LINKEDIN_AUTHOR         = {author}
  Variable  LINKEDIN_TOKEN_EXPIRES  = {expires.isoformat()}

The token expires on {expires.strftime("%d %B %Y")}. GitHub will open an issue (and email you) a week before.
''')


def save_to_github(code):
    access, expires, author, name = exchange(code.strip(), WEB_REDIRECT)
    print(f'::add-mask::{access}')
    if page_mode:
        subprocess.run(['gh', 'secret', 'set', 'LINKEDIN_PAGE_ACCESS_TOKEN'], input=access, text=True, check=True)
        subprocess.run(['gh', 'variable', 'set', 'LINKEDIN_PAGE_TOKEN_EXPIRES', '--body', expires.isoformat()], check=True)
        return name, expires
    subprocess.run(['gh', 'secret', 'set', 'LINKEDIN_ACCESS_TOKEN'], input=access, text=True, check=True)
    subprocess.run(['gh', 'variable', 'set', 'LINKEDIN_AUTHOR', '--body', author], check=True)
    subprocess.run(['gh', 'variable', 'set', 'LINKEDIN_TOKEN_EXPIRES', '--body', expires.isoformat()], check=True)
    return name, expires


def summary(text):
    print(text)
    path = os.environ.get('GITHUB_STEP_SUMMARY')
    if path:
        with open(path, 'a') as f:
            f.write(text + '\n')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--link', action='store_true', help='print the sign-in link for the website callback')
    ap.add_argument('--code', help='exchange this code and save the token to GitHub')
    ap.add_argument('--page', action='store_true', help='company page app instead of your personal profile')
    args = ap.parse_args()
    global CLIENT_ID, CLIENT_SECRET, page_mode
    if args.page:
        page_mode = True
        CLIENT_ID = os.environ.get('LINKEDIN_PAGE_CLIENT_ID', '').strip()
        CLIENT_SECRET = os.environ.get('LINKEDIN_PAGE_CLIENT_SECRET', '').strip()
        if not CLIENT_ID or not CLIENT_SECRET:
            raise SystemExit('Set the LINKEDIN_PAGE_CLIENT_ID variable and LINKEDIN_PAGE_CLIENT_SECRET secret first '
                             '(from the company page app\'s Auth tab).')
    if not CLIENT_ID or not CLIENT_SECRET:
        raise SystemExit('Set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET first (see the top of this file).')

    if args.page and not (args.code or args.link):
        raise SystemExit('--page works with --link or --code (the browser flow), not the local flow.')
    if args.code:
        name, expires = save_to_github(args.code)
        summary(f'### ✅ LinkedIn connected\nSigned in as **{name}**. The token is saved and lasts until '
                f'**{expires.strftime("%d %B %Y")}**. GitHub will remind you a week before.')
    elif args.link:
        summary(f'### Step 1 of 2: sign in to LinkedIn\n[**Open this link**]({auth_url(WEB_REDIRECT, "blog")}), '
                'click **Allow**, then copy the code shown on the page you land on.\n\n'
                '### Step 2 of 2\nRun this workflow again and paste the code into the box'
                + (', with account **page** selected again.' if page_mode else '.'))
    else:
        local_flow()


if __name__ == '__main__':
    main()
