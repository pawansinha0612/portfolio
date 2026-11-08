"""Used by the "Add a video" workflow. Edits docs/videos/videos.json or social.json from the form inputs."""
import datetime as dt
import json
import os
import sys
from pathlib import Path

D = Path('docs/videos')
env = lambda k: (os.environ.get(k) or '').strip()


def fail(msg):
    print(f'::error::{msg}')
    sys.exit(1)


if env('WHAT') == 'Set channel links':
    p = D / 'social.json'
    social = json.loads(p.read_text(encoding='utf-8'))
    changed = []
    for key, var in (('youtube', 'YT'), ('tiktok', 'TT'), ('instagram', 'IG')):
        v = env(var)
        if v:
            if not v.startswith('https://'):
                fail(f'{key} link must start with https://')
            social[key] = v
            changed.append(key)
    if not changed:
        fail('Fill in at least one channel link.')
    p.write_text(json.dumps(social, indent=2) + '\n', encoding='utf-8')
    print('Set: ' + ', '.join(changed))
    sys.exit(0)

url, title = env('URL'), env('TITLE')
if not url.startswith('https://'):
    fail('The video link must start with https://')
if not title:
    fail('Give the video a title.')
related = env('RELATED')
if related and not related.startswith('/'):
    related = '/' + related
melb = dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=11)
entry = {'platform': env('PLATFORM') or 'youtube', 'url': url, 'title': title,
         'date': melb.date().isoformat(), 'topic': env('TOPIC') or 'perf'}
if related:
    entry['related'] = related
if env('FEATURED') == 'true':
    entry['featured'] = True
p = D / 'videos.json'
data = json.loads(p.read_text(encoding='utf-8'))
if any(v.get('url') == url for v in data.get('videos', [])):
    fail('That link is already on the site.')
data.setdefault('videos', []).insert(0, entry)
p.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
print('Added:', json.dumps(entry, ensure_ascii=False))
