"""Get a LinkedIn access token for the blog's daily posting (run on your own computer, every ~60 days).

1. In your LinkedIn developer app, under Auth, add this redirect URL:  http://localhost:8765/callback
2. Run (Client ID and Client Secret are on the app's Auth tab):
       LINKEDIN_CLIENT_ID=xxx LINKEDIN_CLIENT_SECRET=yyy python3 blog/linkedin_auth.py
3. Sign in and approve in the browser window that opens.
4. Copy the three values it prints into GitHub (Settings → Secrets and variables → Actions).

Nothing is saved to disk. Uses only the Python standard library.
"""
import datetime as dt
import http.server
import json
import os
import secrets
import urllib.parse
import urllib.request
import webbrowser

CLIENT_ID = os.environ.get('LINKEDIN_CLIENT_ID', '').strip()
CLIENT_SECRET = os.environ.get('LINKEDIN_CLIENT_SECRET', '').strip()
REDIRECT = 'http://localhost:8765/callback'
SCOPES = 'openid profile w_member_social'


def main():
    if not CLIENT_ID or not CLIENT_SECRET:
        raise SystemExit('Set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET first (see the top of this file).')
    state = secrets.token_urlsafe(16)
    auth_url = 'https://www.linkedin.com/oauth/v2/authorization?' + urllib.parse.urlencode({
        'response_type': 'code', 'client_id': CLIENT_ID, 'redirect_uri': REDIRECT, 'state': state, 'scope': SCOPES,
    })
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

    print('Opening LinkedIn in your browser. If it does not open, visit:\n' + auth_url)
    webbrowser.open(auth_url)
    with http.server.HTTPServer(('localhost', 8765), Handler) as server:
        while 'code' not in result and 'error' not in result:
            server.handle_request()

    if 'error' in result:
        raise SystemExit(f'LinkedIn returned an error: {result.get("error")}: {result.get("error_description", "")}')
    if result.get('state') != state:
        raise SystemExit('State mismatch; please run the script again.')

    body = urllib.parse.urlencode({
        'grant_type': 'authorization_code', 'code': result['code'], 'redirect_uri': REDIRECT,
        'client_id': CLIENT_ID, 'client_secret': CLIENT_SECRET,
    }).encode()
    with urllib.request.urlopen(urllib.request.Request('https://www.linkedin.com/oauth/v2/accessToken', data=body)) as r:
        token = json.load(r)
    access = token['access_token']
    expires = dt.date.today() + dt.timedelta(seconds=int(token.get('expires_in', 0)))

    req = urllib.request.Request('https://api.linkedin.com/v2/userinfo', headers={'Authorization': f'Bearer {access}'})
    with urllib.request.urlopen(req) as r:
        me = json.load(r)

    print(f'''
Signed in as {me.get("name", "?")}. Add these in GitHub → your portfolio repo → Settings → Secrets and variables → Actions:

  Secret    LINKEDIN_ACCESS_TOKEN   = {access}
  Variable  LINKEDIN_AUTHOR         = urn:li:person:{me["sub"]}
  Variable  LINKEDIN_TOKEN_EXPIRES  = {expires.isoformat()}

The token expires on {expires.strftime("%d %B %Y")}. GitHub will open an issue (and email you) a week before.
''')


if __name__ == '__main__':
    main()
