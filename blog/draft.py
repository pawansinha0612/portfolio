"""Draft the next blog posts with a free AI model and save them to blog/posts/ for review.

The weekly GitHub Action runs this and opens a pull request. Merging the pull request approves the drafts;
blog/build.py then publishes one a day on its scheduled date.

Topics come from blog/topics.md (the first unticked "- [ ]" lines). The writing style comes from blog/voice.md.

The model is any OpenAI-compatible chat API. Default: NVIDIA's free hosted models (build.nvidia.com).
(GitHub Models was the first choice but GitHub retired it on 30 July 2026.)
Settings (repository variables/secrets):
    AI_API_KEY   the provider's key (secret). For NVIDIA: build.nvidia.com → Get API Key (starts with nvapi-)
    AI_BASE_URL  optional, default https://integrate.api.nvidia.com/v1
                 e.g. Google Gemini: https://generativelanguage.googleapis.com/v1beta/openai
    AI_MODEL     optional, comma-separated; each is tried in turn if the one before fails.
                 Model IDs for NVIDIA: https://integrate.api.nvidia.com/v1/models

    python3 blog/draft.py --count 7
"""
import argparse
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
from build import POSTS, parse, today  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
TOPICS = ROOT / 'blog' / 'topics.md'
VOICE = ROOT / 'blog' / 'voice.md'
SUMMARY = ROOT / 'blog' / '.draft-summary.md'  # pull request body, not committed

BASE_URL = os.environ.get('AI_BASE_URL') or 'https://integrate.api.nvidia.com/v1'
MODELS = [m.strip() for m in (os.environ.get('AI_MODEL') or
          'google/gemma-4-31b-it,mistralai/mistral-large-2-instruct,moonshotai/kimi-k2.6').split(',') if m.strip()]
API_KEY = os.environ.get('AI_API_KEY', '').strip()
used_model = MODELS[0]  # the model that actually wrote the drafts, for the pull request

TOPIC_RE = re.compile(r'^- \[ \] (.+)$')

FORMAT = '''Write one blog post on the topic below. Reply with only a JSON object, no code fences, with these keys:
  "title":    a specific, plain title (under 70 characters, no clickbait)
  "summary":  one or two sentences for the blog list and link previews (under 200 characters)
  "tags":     2 to 4 short tags, e.g. ["Performance", "k6"]
  "body":     the article in Markdown, 600 to 900 words. Use ## subheadings, short paragraphs, and a code block,
              table or checklist where it genuinely helps. Do not repeat the title as a heading.
  "linkedin": the LinkedIn post, 120 to 200 words. Start with a one-line hook, give one concrete takeaway,
              end with a question to invite comments. No hashtag walls (at most 3), no links, no emojis in every line.

Topic: {topic}'''


def next_topics(n):
    lines = TOPICS.read_text(encoding='utf-8').split('\n')
    picked = [(i, m.group(1).strip()) for i, l in enumerate(lines) if (m := TOPIC_RE.match(l))][:n]
    remaining = sum(1 for l in lines if TOPIC_RE.match(l)) - len(picked)
    return lines, picked, remaining


def mark_done(lines, picked):
    for i, _ in picked:
        lines[i] = lines[i].replace('- [ ]', '- [x]', 1)
    TOPICS.write_text('\n'.join(lines), encoding='utf-8')


def first_free_date():
    dates = [parse(p)['date'] for p in POSTS.glob('*.md')]
    return max([today()] + dates) + dt.timedelta(days=1)


class ModelFailed(Exception):
    pass


def call_model(model, topic):
    body = json.dumps({
        'model': model,
        'temperature': 0.7,
        'max_tokens': 4096,
        'messages': [
            {'role': 'system', 'content': VOICE.read_text(encoding='utf-8')},
            {'role': 'user', 'content': FORMAT.format(topic=topic)},
        ],
    }).encode()
    req = urllib.request.Request(BASE_URL.rstrip('/') + '/chat/completions', data=body, headers={
        'Authorization': f'Bearer {API_KEY}', 'Content-Type': 'application/json', 'Accept': 'application/json',
    })
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=150) as r:
                raw = r.read().decode(errors='replace')
                status, ctype = r.status, r.headers.get('content-type', '')
            return json.loads(raw)['choices'][0]['message']['content'] or ''
        except urllib.error.HTTPError as err:
            detail = err.read().decode(errors='replace')[:300]
            if err.code in (401, 403):
                raise SystemExit(f'The AI service rejected the key (HTTP {err.code}). Check the AI_API_KEY secret. {detail}')
            if err.code in (429, 500, 502, 503, 504) and attempt < 3:
                wait = int(err.headers.get('retry-after') or 30 * (attempt + 1))
                print(f'  HTTP {err.code}, waiting {wait}s')
                time.sleep(wait)
                continue
            raise ModelFailed(f'HTTP {err.code} {detail}')
        except (json.JSONDecodeError, KeyError, IndexError, TypeError):
            # The service answered, but not with a chat completion (empty body, HTML error page, etc.)
            print(f'  unexpected reply: HTTP {status} {ctype!r}: {raw[:300]!r}')
            if attempt < 3:
                time.sleep(20 * (attempt + 1))
                continue
            raise ModelFailed('no chat reply')
        except (urllib.error.URLError, TimeoutError) as err:
            if attempt < 1:  # a slow model rarely speeds up; move on to the next one quickly
                print(f'  no answer from {model} ({err}), retrying once')
                time.sleep(10)
                continue
            raise ModelFailed(f'too slow or unreachable: {err}')


def ask_model(topic):
    global used_model
    for model in [used_model] + [m for m in MODELS if m != used_model]:
        try:
            text = call_model(model, topic)
            used_model = model
            break
        except ModelFailed as err:
            print(f'  {model} failed ({err}); trying the next model')
    else:
        raise ModelFailed(f'none of the models worked at {BASE_URL}: {", ".join(MODELS)}')
    text = re.sub(r'<think>.*?</think>', '', text, flags=re.S)  # reasoning models may think out loud first
    text = re.sub(r'^```(?:json)?\s*|\s*```$', '', text.strip())
    post = json.loads(text[text.index('{'):text.rindex('}') + 1])
    for key in ('title', 'summary', 'body', 'linkedin'):
        if not str(post.get(key, '')).strip():
            raise ValueError(f'model reply is missing "{key}"')
    return post


def slugify(title):
    return re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-')[:60].rstrip('-')


def one_line(s):
    return ' '.join(str(s).split())


def write_post(post, date):
    tags = post.get('tags') or []
    if isinstance(tags, str):
        tags = tags.split(',')
    linkedin = '\n'.join('  ' + l for l in str(post['linkedin']).strip().split('\n'))
    path = POSTS / f'{date.isoformat()}-{slugify(post["title"])}.md'
    path.write_text(f'''---
title: {one_line(post["title"])}
date: {date.isoformat()}
summary: {one_line(post["summary"])}
tags: {", ".join(one_line(t) for t in tags)}
linkedin: |
{linkedin}
---
{str(post["body"]).strip()}
''', encoding='utf-8')
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--count', type=int, default=7)
    args = ap.parse_args()
    if not API_KEY:
        raise SystemExit('No AI key: add the AI_API_KEY secret (free from build.nvidia.com → Get API Key).')
    POSTS.mkdir(parents=True, exist_ok=True)

    lines, picked, remaining = next_topics(args.count)
    if not picked:
        raise SystemExit('No unticked topics left in blog/topics.md. Add some "- [ ] topic" lines.')

    date = first_free_date()
    made, done, skipped = [], [], []
    for i, (n, topic) in enumerate(picked):
        print(f'Drafting: {topic}')
        try:
            try:
                post = ask_model(topic)
            except (ValueError, json.JSONDecodeError) as err:  # one retry for a malformed reply
                print(f'  bad reply ({err}), retrying once')
                post = ask_model(topic)
        except (ModelFailed, ValueError, json.JSONDecodeError) as err:
            print(f'  skipped this topic ({err}); it stays in the queue for next time')
            skipped.append(topic)
            continue
        path = write_post(post, date)
        made.append((date, post['title'], path.name))
        done.append((n, topic))
        date += dt.timedelta(days=1)
        if i < len(picked) - 1:
            time.sleep(5)  # stay well inside the free rate limits
    if not made:
        raise SystemExit('No posts could be drafted. Check the messages above; to change models set the AI_MODEL '
                         'variable (IDs: https://integrate.api.nvidia.com/v1/models).')
    mark_done(lines, done)
    remaining += len(skipped)

    skip_note = ('\n\nCould not draft (left in the queue): ' + '; '.join(skipped)) if skipped else ''
    rows = '\n'.join(f'| {d.strftime("%a %d %b")} | {t} | `blog/posts/{n}` |' for d, t, n in made)
    low = f'\n\n⚠️ Only {remaining} topics left in `blog/topics.md`. Add more soon.' if remaining < 7 else ''
    SUMMARY.write_text(f'''Drafted by `{used_model}`. Review each post, edit anything that isn't right, then **merge** to approve.
Each post goes live on its date at about 8am Melbourne time and is shared on LinkedIn.

| Publishes | Title | File |
|---|---|---|
{rows}

To skip a post, delete its file before merging. To change the date, edit `date:` in the file.{low}{skip_note}
''', encoding='utf-8')
    print(f'Drafted {len(made)} post(s); {remaining} topics left.')


if __name__ == '__main__':
    main()
