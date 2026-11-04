#!/usr/bin/env python3
"""Builds the interview-prep role pages from template.html.

Writes docs/interview-prep/<slug>/index.html for every role in TRACKS, plus the hub
docs/interview-prep/index.html. Questions live in docs/interview-prep/qa*.js (one file per role).

Run:  python3 interview-prep/build.py
"""
import html
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / 'docs' / 'interview-prep'
TEMPLATE = (Path(__file__).parent / 'template.html').read_text()

JUNIOR = [('0–2 years', 'concepts and fundamentals'), ('2–5 years', 'design, tools, owning an area'), ('5+ years', 'strategy, scale, hard scenarios')]

TRACKS = [
    dict(track='performance', slug='performance-testing', file='qa.js', store='perf-prep-done', icon='⚡',
         short='Performance testing', title='Performance Testing Interview Questions', eyebrow='Performance engineering',
         h1='Performance testing interview questions',
         desc='Performance testing interview questions with model answers for 3–5, 5–7 and 7+ years: k6, JMeter, LoadRunner, bottlenecks, JVM GC and capacity planning.',
         ogdesc='Model answers for performance testing interviews, from 3 to 7+ years of experience.',
         lead="Questions I've been asked, or asked other candidates, over 12+ years of performance testing in banking, payments and gaming. Each one has a model answer you can adapt to your own projects. Pick your experience level to start.",
         tags=['k6', 'JMeter', 'LoadRunner', 'APM &amp; observability', 'JVM &amp; database tuning', 'Cloud &amp; Kubernetes', 'CI/CD'],
         levels=[('3–5 years', 'concepts, metrics, scripting'), ('5–7 years', 'bottlenecks, monitoring, CI/CD'), ('7+ years', 'tuning, capacity, strategy')],
         search='Search questions and answers, e.g. pacing, GC, Kafka',
         chips=['k6', 'LoadRunner', 'JMeter', 'Gatling', 'Observability', 'Cloud', 'Database', 'Monitoring tools'],
         claim="If a platform team ran the Kubernetes runners and you consumed them, say so, and show you understand why each setting matters.",
         mock='performance testing', mockx='a whiteboard-style design question',
         guide=' Want every question with what the interviewer is really testing, a cheat sheet and a prep plan? Get the <a href="/interview-prep/guide/">Performance Testing Interview Guide</a>.',
         card='k6, JMeter, LoadRunner, bottlenecks, JVM, capacity and cloud.'),
    dict(track='manual', slug='manual-testing', file='qa-manual.js', store='manual-prep-done', icon='🧪',
         short='Manual testing', title='Manual Testing Interview Questions', eyebrow='Manual &amp; functional testing',
         h1='Manual and functional testing interview questions',
         desc='Manual and functional testing interview questions with model answers for 0–2, 2–5 and 5+ years: test design, bug reports, exploratory, regression, UAT and Agile.',
         ogdesc='Model answers for manual and functional testing interviews, from first job to senior tester.',
         lead='The questions that come up in manual and functional testing interviews, from your first QA job to senior tester. Each one has a model answer you can adapt to your own projects. Pick your experience level to start.',
         tags=['Test design', 'Bug reports', 'Exploratory', 'Regression', 'UAT', 'Agile', 'Accessibility'],
         levels=JUNIOR, search='Search questions and answers, e.g. boundary, severity, UAT',
         chips=['Fundamentals', 'Test design', 'Defects', 'Exploratory', 'Agile', 'Regression', 'UAT', 'Accessibility', 'SQL', 'Scenarios'],
         claim="If you followed someone else's test plan, say so, and show you understand why it was written that way.",
         mock='manual testing', mockx='a "how would you test this?" exercise',
         guide='', card='Test design, bug reports, exploratory, regression, UAT and Agile.'),
    dict(track='api', slug='api-testing', file='qa-api.js', store='api-prep-done', icon='🔌',
         short='API testing', title='API Testing Interview Questions', eyebrow='API testing',
         h1='API testing interview questions',
         desc='API testing interview questions with model answers for 0–2, 2–5 and 5+ years: REST, status codes, auth and OAuth, Postman, contract testing, GraphQL and API security.',
         ogdesc='Model answers for API testing interviews: REST, auth, Postman, contract testing and security.',
         lead='The questions that come up in API testing interviews: REST and HTTP, auth, Postman, contract tests, microservices and API security. Each one has a model answer you can adapt to your own projects. Pick your experience level to start.',
         tags=['REST &amp; HTTP', 'OAuth &amp; JWT', 'Postman', 'Contract testing', 'GraphQL', 'Microservices', 'API security'],
         levels=JUNIOR, search='Search questions and answers, e.g. idempotent, 401, Pact',
         chips=['HTTP & REST', 'Auth', 'Postman', 'Contract', 'Test design', 'Automation', 'GraphQL', 'Microservices', 'Security', 'Data'],
         claim="If you only ran an existing Postman collection, say so, and show you understand what each test checks and why.",
         mock='API testing', mockx='a live "test this endpoint" exercise',
         guide='', card='REST, status codes, OAuth and JWT, Postman, contract tests and API security.'),
    dict(track='playwright', slug='playwright', file='qa-playwright.js', store='playwright-prep-done', icon='🎭',
         short='Playwright', title='Playwright Interview Questions', eyebrow='Test automation · Playwright',
         h1='Playwright automation interview questions',
         desc='Playwright interview questions with model answers for 0–2, 2–5 and 5+ years: locators, auto-waiting, fixtures, API testing, flaky tests, CI and framework design.',
         ogdesc='Model answers for Playwright UI and API automation interviews, from first suite to framework lead.',
         lead='The questions that come up in Playwright automation interviews, for UI and API tests in TypeScript: locators, waits, fixtures, API testing, flaky tests, CI and framework design. Pick your experience level to start.',
         tags=['Locators', 'Auto-waiting', 'Fixtures', 'API testing', 'Trace viewer', 'CI/CD', 'TypeScript'],
         levels=JUNIOR, search='Search questions and answers, e.g. getByRole, storageState, flaky',
         chips=['Basics', 'Locators', 'Waits & flakiness', 'Fixtures', 'API testing', 'Framework design', 'CI/CD', 'Debugging', 'Visual & a11y', 'TypeScript'],
         claim="If you added tests to a framework someone else designed, say so, and show you understand the choices behind it.",
         mock='Playwright automation', mockx='a short live-coding or code-review exercise',
         guide='', card='Locators, auto-waiting, fixtures, API tests, flaky tests and CI.'),
    dict(track='mobile', slug='mobile-testing', file='qa-mobile.js', store='mobile-prep-done', icon='📱',
         short='Mobile testing', title='Mobile App Testing Interview Questions', eyebrow='Mobile app testing',
         h1='Mobile app testing interview questions',
         desc='Mobile app testing interview questions with model answers for 0–2, 2–5 and 5+ years: Android and iOS, Appium, device clouds, network, performance and app security.',
         ogdesc='Model answers for mobile testing interviews: Android, iOS, Appium, devices, performance and security.',
         lead='The questions that come up in mobile testing interviews: Android and iOS, real devices and device clouds, Appium, poor networks, app performance, security and releases. Pick your experience level to start.',
         tags=['Android', 'iOS', 'Appium', 'Device clouds', 'Network', 'App performance', 'Security'],
         levels=JUNIOR, search='Search questions and answers, e.g. adb, deep link, Appium',
         chips=['Fundamentals', 'Android', 'iOS', 'Appium', 'Devices & cloud', 'Performance', 'Network', 'Security', 'Release', 'Automation strategy'],
         claim="If another team owned the device lab or the release pipeline, say so, and show you understand how it worked.",
         mock='mobile testing', mockx='a "how would you test this app?" exercise',
         guide='', card='Android, iOS, Appium, device clouds, networks, performance and security.'),
    dict(track='lead', slug='qa-lead', file='qa-lead.js', store='lead-prep-done', icon='🧭',
         short='QA lead', title='QA Lead and Test Manager Interview Questions', eyebrow='QA leadership',
         h1='QA lead and test manager interview questions',
         desc='QA lead and test manager interview questions with model answers, from first lead role to head of QA: test strategy, metrics, risk, people, stakeholders and automation strategy.',
         ogdesc='Model answers for QA lead, test manager and head of QA interviews.',
         lead='The questions that come up when you interview for QA lead, test manager or head of QA: strategy, risk, metrics, people, stakeholders and automation. For the "tell me about a time" ones, the answer gives you the shape and you bring the story.',
         tags=['Test strategy', 'Metrics', 'Risk', 'People', 'Stakeholders', 'Automation strategy', 'Hiring'],
         levels=[('First lead role', 'leading 1–3 testers'), ('Test lead / manager', 'a team or a programme'), ('Head of QA', 'quality across an organisation')],
         search='Search questions and answers, e.g. strategy, metrics, go/no-go',
         chips=['Strategy', 'Planning', 'Metrics', 'People', 'Stakeholders', 'Risk', 'Process', 'Automation strategy', 'Hiring', 'Scenarios'],
         claim="If you supported a decision rather than made it, say so, and explain what you'd do in the lead's seat.",
         mock='QA lead', mockx='a scenario on a release under pressure',
         guide='', card='Test strategy, metrics, risk, people, stakeholders and automation strategy.'),
]


def count_questions(t):
    """Counts questions per level by running the qa file in node."""
    js = (f"global.window={{}};require({json.dumps(str(DOCS / t['file']))});"
          f"const q=window.QA_TRACKS&&window.QA_TRACKS[{json.dumps(t['track'])}]||window.QA;"
          "console.log(JSON.stringify(Object.fromEntries(Object.entries(q).map(([k,v])=>[k,v.length]))))")
    out = subprocess.run(['node', '-e', js], capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def page(t):
    levels = '\n        '.join(
        f'<button class="level" role="tab" data-level="{key}" aria-selected="{str(key == "basic").lower()}">'
        f'<b>{name}</b><span>{years} · {what}</span></button>'
        for key, name, (years, what) in zip(['basic', 'intermediate', 'advanced'], ['Basic', 'Intermediate', 'Advanced'], t['levels']))
    if t['track'] == 'lead':  # the level names are the roles themselves
        levels = '\n        '.join(
            f'<button class="level" role="tab" data-level="{key}" aria-selected="{str(key == "basic").lower()}">'
            f'<b>{years}</b><span>{lvl} · {what}</span></button>'
            for key, lvl, (years, what) in zip(['basic', 'intermediate', 'advanced'], ['Basic', 'Intermediate', 'Advanced'], t['levels']))
    roles = ''.join(
        f'<a href="/interview-prep/{o["slug"]}/"' + (' aria-current="page"' if o is t else '') + f'>{o["icon"]} {o["short"]}</a>'
        for o in TRACKS)
    values = {
        'TITLE': t['title'], 'DESC': t['desc'], 'OGDESC': t['ogdesc'], 'SLUG': t['slug'], 'SHORT': t['short'],
        'EYEBROW': t['eyebrow'], 'H1': t['h1'], 'LEAD': t['lead'],
        'TAGS': '\n'.join(f'        <span class="tag">{x}</span>' for x in t['tags']),
        'ROLES': roles, 'LEVELS': levels, 'SEARCH': t['search'],
        'CHIPS': '\n'.join(f'        <button class="tool" type="button" data-tool="{html.escape(c)}" aria-pressed="false">{html.escape(c)}</button>' for c in t['chips']),
        'TRACK': t['track'], 'GUIDE': t['guide'], 'CLAIM': t['claim'], 'MOCK': t['mock'], 'MOCKX': t['mockx'],
        'QAFILE': t['file'], 'STORE': t['store'],
    }
    out = re.sub(r'\{\{([A-Z0-9]+)\}\}', lambda m: values[m.group(1)], TEMPLATE)
    assert '{{' not in out, re.findall(r'.{40}\{\{.{40}', out)
    return out


def hub(counts):
    src = (DOCS / 'performance-testing' / 'index.html').read_text()
    head_end = src.index('<style>')
    cards = '\n'.join(
        f'''        <a class="card project-card" href="/interview-prep/{t["slug"]}/" data-track="prep-{t["track"]}"><div class="icon">{t["icon"]}</div><h3>{t["short"]}</h3><p>{counts[t["track"]]} questions with model answers, basic to advanced. {t["card"]}</p><span class="project-link">Start practising →</span></a>'''
        for t in TRACKS if t['track'] in counts)
    total = sum(counts.values())
    head = src[:head_end]
    head = head.replace('<title>Performance Testing Interview Questions — Pawan Sinha</title>', '<title>Software Testing Interview Questions — Pawan Sinha</title>')
    head = re.sub(r'<meta name="description" content="[^"]*">', f'<meta name="description" content="{total} software testing interview questions with model answers, basic to advanced: performance, manual, API, Playwright, mobile testing and QA lead.">', head)
    head = re.sub(r'<meta property="og:title" content="[^"]*">', '<meta property="og:title" content="Software Testing Interview Questions — Pawan Sinha">', head)
    head = re.sub(r'<meta property="og:description" content="[^"]*">', '<meta property="og:description" content="Interview questions with model answers for every testing role, basic to advanced.">', head)
    head = head.replace('https://pawansinha.com.au/interview-prep/performance-testing/', 'https://pawansinha.com.au/interview-prep/')
    nav_start = src.index('<body>')
    nav_end = src.index('<nav class="subnav')
    foot_start = src.index('<footer class="site-footer">')
    foot_end = src.index('<script src="/interview-prep/')
    footer = src[foot_start:foot_end].replace('<a href="/interview-prep/performance-testing/">Interview prep</a>', '<a href="/interview-prep/">Interview prep</a>')
    return head + '''<style>
    .project-hero { padding: 64px 16px 24px; }
    .project-hero h1 { font-size: clamp(32px, 5vw, 48px); line-height: 1.1; margin: 0 0 16px; }
    .prep-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
    @media (max-width: 700px) { .project-hero { padding-top: 40px; } }
  </style>
</head>
''' + src[nav_start:nav_end] + f'''<main>
    <section class="wrap project-hero">
      <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span aria-hidden="true">/</span><a href="/learn/">Learn</a><span aria-hidden="true">/</span><span aria-current="page">Interview prep</span></nav>
      <p class="eyebrow">Interview prep · every testing role</p>
      <h1>Software testing interview questions</h1>
      <p class="lead">{total} questions with model answers, for six testing roles. Each role has three levels, basic, intermediate and advanced, so you can start where you are and work up. Free, no sign-up.</p>
    </section>

    <section class="wrap" style="padding: 8px 16px 40px;">
      <div class="prep-grid">
{cards}
      </div>
    </section>

    <section class="wrap" style="padding: 0 16px 80px;">
      <div class="prep-grid">
        <a class="card project-card" href="/interview-prep/practice/" data-track="prep-practice"><div class="icon">🎙️</div><h3>AI mock interview</h3><p>Pick a role and level, answer out loud or in writing, and get a score, what you missed and a stronger answer. 3 free answers a day.</p><span class="project-link">Practise now →</span></a>
        <a class="card project-card" href="/interview-prep/guide/" data-track="prep-guide"><div class="icon">📘</div><h3>Performance Testing Interview Guide</h3><p>All 92 performance questions in a 64-page PDF, with a cheat sheet, STAR story templates and prep plans.</p><span class="project-link">See the guide →</span></a>
        <a class="card project-card" href="/?need=Interview%20coaching#contact" data-track="prep-mock"><div class="icon">🤝</div><h3>Mock interview with me</h3><p>60 minutes at your level, with follow-up questions and honest written feedback on what to work on.</p><span class="project-link">Request a session →</span></a>
      </div>
    </section>
  </main>

  ''' + footer + '''<script src="/chat.js" data-endpoint="https://script.google.com/macros/s/AKfycbzvFENGzJ59oV9fx3Vc6CFzkjVpv5uFCx3Ob4zp_gfw0tNCXCI8TQYwJ9zQfkHQrARF/exec" data-booking-url="https://calendly.com/pawansinha4u/30min" defer></script>
  <script src="/glow.js" defer></script>
  <script src="/menu.js" defer></script>
</body>
</html>
'''


def main():
    counts = {}
    for t in TRACKS:
        if not (DOCS / t['file']).exists():
            print('skip (no questions yet):', t['file'])
            continue
        c = count_questions(t)
        counts[t['track']] = sum(c.values())
        d = DOCS / t['slug']
        d.mkdir(exist_ok=True)
        (d / 'index.html').write_text(page(t))
        print(f"{t['slug']}: {c}")
    # The hub only lists roles that have questions.
    (DOCS / 'index.html').write_text(hub(counts))
    print('hub:', sum(counts.values()), 'questions')


if __name__ == '__main__':
    main()
