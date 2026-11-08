"""Check this week's AI drafts before a human reviews them, and add the findings to the pull request body.

Two kinds of checks:
  1. Fixed rules that are always reliable: title and description length, semicolons in prose, banned phrases,
     made-up personal stories, missing LinkedIn question.
  2. A free AI model acting as a strict technical fact-checker. It flags wrong facts, maths that doesn't add up,
     tool options or metrics that don't exist, and invented statistics. It can miss things and it can be wrong:
     it tells you where to look, it doesn't replace reading.

It also writes a one-line "repost with your thoughts" question for each post.

Run after draft.py (the Blog drafts workflow does this):
    python3 blog/review.py            # files listed in blog/.draft-files
    python3 blog/review.py FILE...    # or these posts
Env: same AI_* variables as draft.py, plus optional REVIEW_MODEL (comma-separated) to use a different model.
"""
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import draft  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
POSTS = ROOT / 'blog' / 'posts'
SUMMARY = ROOT / 'blog' / '.draft-summary.md'

BANNED = ['delve', 'game-changer', 'game changer', 'landscape', 'unlock', "in today's", 'fast-paced', 'seamless',
          'leverage', 'cutting-edge', 'revolutionize', 'revolutionise']
ANECDOTE = re.compile(r"\b(on my (last|previous|current) project|i once|in a recent (test|project)|i caught|"
                      r"we (once|recently) (saw|found|had)|a client of mine|last year i|i've seen this at)\b", re.I)

REVIEW_PROMPT = '''You are a strict technical editor and fact-checker for a blog read by senior performance engineers and SREs.
Find concrete errors in the article below. Only report real problems a senior engineer would object to:
- wrong facts, definitions or units
- maths or worked examples that don't add up (redo every calculation)
- tool options, flags, commands, metric names, functions or APIs that don't exist or are used wrongly
  (k6, JMeter, Prometheus, Grafana, JVM, Linux, Kubernetes, AWS, databases and so on)
- invented statistics, studies, quotes or version numbers, or credit given to the wrong person
- claims stated as universal truth that are only sometimes true
Do not comment on style, tone or length. Do not invent problems. If unsure, say "check" not "error".

Reply with only a JSON object, no code fences:
{{"issues": [{{"severity": "error" or "check", "quote": "the exact words from the article (under 20 words)",
  "problem": "what is wrong, one sentence", "fix": "the corrected statement, one sentence"}}],
 "repost": "one short question (under 25 words) for a LinkedIn repost of this article, no semicolons, a check readers can act on"}}
At most 10 issues, most serious first. An empty list is fine when the article is correct.

ARTICLE:
{article}'''


def split_post(text):
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', text, re.S)
    if not m:
        return {}, text
    meta, key = {}, None
    for line in m.group(1).split('\n'):
        if line.startswith('  ') and key:
            meta[key] += '\n' + line.strip()
        elif ':' in line:
            key, _, val = line.partition(':')
            key = key.strip()
            meta[key] = val.strip().lstrip('|').strip()
    return meta, m.group(2)


def prose(body):
    """Body without code blocks, inline code, tables or formulas, for style checks."""
    body = re.sub(r'```.*?```', '', body, flags=re.S)
    body = re.sub(r'`[^`]*`', '', body)
    body = re.sub(r'\\\[.*?\\\]|\\\(.*?\\\)|\$\$.*?\$\$', '', body, flags=re.S)
    return '\n'.join(l for l in body.split('\n') if not l.lstrip().startswith('|'))


def rule_checks(meta, body):
    out = []
    title = meta.get('title', '')
    if len(title) > 70:
        out.append(f'Title is {len(title)} characters (keep it under 70).')
    desc = meta.get('description', '')
    if not desc:
        out.append('No `description:` line (used by Google).')
    elif len(desc) > 155:
        out.append(f'Description is {len(desc)} characters (Google cuts it at about 155).')
    text = prose(body)
    semis = [l.strip() for l in text.split('\n') if ';' in l]
    if semis:
        out.append(f'{len(semis)} line(s) with a semicolon in prose, e.g. "{semis[0][:80]}". Split the sentence.')
    low = text.lower() + '\n' + meta.get('linkedin', '').lower()
    hits = sorted({w for w in BANNED if w in low})
    if hits:
        out.append('Banned phrases: ' + ', '.join(f'"{h}"' for h in hits) + '.')
    for m in ANECDOTE.finditer(text + '\n' + meta.get('linkedin', '')):
        out.append(f'Sounds like a personal story ("{m.group(0)}"). The honesty rules forbid invented experiences.')
        break
    if '?' not in meta.get('linkedin', ''):
        out.append('The LinkedIn post does not end with a question.')
    if body.lstrip().startswith('#'):
        out.append('The article starts with a heading. Start with the problem scenario instead.')
    return out


def ai_review(article):
    models = [m.strip() for m in (os.environ.get('REVIEW_MODEL') or ','.join(draft.MODELS)).split(',') if m.strip()]
    last = 'the review model was unreachable earlier in this run' if models else 'no model configured'
    for model in models:
        if model in draft.unavailable:
            continue
        try:
            text = draft.chat(model, 'You check technical articles for errors. You reply with JSON only.',
                              REVIEW_PROMPT.format(article=article), 0.1)
            text = re.sub(r'<think>.*?</think>', '', text, flags=re.S)
            data = json.loads(text[text.index('{'):text.rindex('}') + 1])
            issues = [i for i in data.get('issues') or [] if isinstance(i, dict) and i.get('problem')]
            return model, issues[:10], str(data.get('repost') or '').strip()
        except (draft.ModelFailed, ValueError, json.JSONDecodeError) as err:
            last = f'{model}: {err}'
            print(f'  review with {model} failed ({str(err)[:200]})')
    return None, last, ''


def esc(s):
    return str(s).replace('|', '\\|').replace('\n', ' ').strip()


def main():
    files = sys.argv[1:]
    if not files:
        listing = ROOT / 'blog' / '.draft-files'
        files = [str(POSTS / n) for n in listing.read_text(encoding='utf-8').split('\n') if n.strip()] if listing.exists() else []
    if not files:
        print('Nothing to review.')
        return
    have_key = bool(draft.API_KEY)
    parts, reposts, total_err = ['\n---\n\n## Automatic review\n',
                                 'Fixed rules are always right. The AI fact-check is a second opinion from a free model: '
                                 'it points at lines worth checking, it can miss errors and it can be wrong. '
                                 'Look up anything it flags before you change it.\n'], [], 0
    for f in files:
        path = Path(f)
        text = path.read_text(encoding='utf-8')
        meta, body = split_post(text)
        title = meta.get('title', path.name)
        print(f'Reviewing: {title}')
        parts.append(f'\n### {title}\n`{path.name}`\n')
        rules = rule_checks(meta, body)
        parts.append('**Rules:** ' + ('all passed ✅' if not rules else '') + '\n')
        parts += [f'- ⚠️ {r}' for r in rules]
        if have_key:
            model, issues, repost = ai_review(f'# {title}\n\n{body}')
            if model is None:
                parts.append(f'\n**AI fact-check:** could not run ({esc(issues)[:200]}). Read this post extra carefully.\n')
            elif not issues:
                parts.append(f'\n**AI fact-check** (`{model}`): nothing flagged. Still read the numbers and code yourself.\n')
            else:
                errs = sum(1 for i in issues if i.get('severity') == 'error')
                total_err += errs
                parts.append(f'\n**AI fact-check** (`{model}`): {len(issues)} to look at\n')
                parts.append('| | Says | Problem | Suggested fix |\n|---|---|---|---|')
                parts += [f'| {"❌" if i.get("severity") == "error" else "🔎"} | {esc(i.get("quote", ""))} | {esc(i.get("problem", ""))} | {esc(i.get("fix", ""))} |' for i in issues]
            if repost:
                repost = ' '.join(repost.replace(';', ',').split())
                reposts.append((meta.get('date', ''), title, repost))
                # Store it in the post too: the 9am daily plan email shows it on the day the post goes live.
                if not re.search(r'^repost:', text.split('\n---\n', 1)[0], re.M):
                    path.write_text(re.sub(r'^(linkedin:)', lambda m: f'repost: {repost}\n' + m.group(1), text,
                                           count=1, flags=re.M), encoding='utf-8')
        else:
            parts.append('\n**AI fact-check:** skipped (no AI key).\n')
    if reposts:
        parts.append('\n## Repost lines\n\nSaved in each post as `repost:`. Your 9am daily plan email shows the day\'s line. Edit it in the post file if you want different words.\n')
        parts += [f'- **{d}, {t}:** {r}' for d, t, r in reposts]
        parts.append('\nCheck each line still matches the post after your edits.')
    head = f'\n\n**{total_err} likely error(s) flagged.** Fix or rule them out before merging.\n' if total_err else ''
    old = SUMMARY.read_text(encoding='utf-8') if SUMMARY.exists() else ''
    SUMMARY.write_text(old + head + '\n'.join(parts) + '\n', encoding='utf-8')
    print(f'Reviewed {len(files)} post(s); {total_err} likely error(s) flagged.')


if __name__ == '__main__':
    main()
