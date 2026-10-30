"""Build the service detail pages (docs/services/<slug>/index.html) from the data below.

    python3 services/build.py

Edit the SERVICES list, run the script, commit docs/services/. Standard library only.
Every claim here comes from the CV (portfolio-private/PerformanceEngineer_PawanSinha.docx) or the home page:
keep it that way, and add real projects to `work` as you finish them.
"""
from html import escape
from html import unescape
from pathlib import Path
from urllib.parse import quote
import json
import re

SITE = 'https://pawansinha.com.au'
EMAIL = 'hello@pawansinha.com.au'
BOOKING = 'https://calendly.com/pawansinha4u/30min'
LINKEDIN = 'https://www.linkedin.com/in/pawan-sinha-b5a356b6/'
OUT = Path(__file__).resolve().parent.parent / 'docs' / 'services'

# Case studies, shared by the service pages that point to them.
CASES = {
    'tlc': dict(tag='Gaming &amp; Lottery', client='The Lottery Corporation', when='2025 to present',
                title='An AI-powered performance testing framework, adopted company-wide',
                challenge='Powerball, Oz Lotto and Keno see massive traffic spikes on draw nights, and hand-scripting load tests couldn\'t keep up with how often the team released.',
                did='Built a k6 framework that generates typed API clients from OpenAPI specs, uses GitLab Duo to turn plain-English scenarios into ready-to-run tests, and runs in GitLab CI on every deployment. Added live Grafana/InfluxDB and Kibana dashboards, and used Dynatrace to trace slow Oracle queries, memory leaks and GC pressure.',
                outcome='Writing test scripts now takes minutes instead of days, every deployment passes a performance gate, and the framework became the standard approach across engineering squads.'),
    'visa': dict(tag='Global Payments', client='Visa', when='2022 to 2024',
                 title='Scalability for high-volume transaction processing',
                 challenge='Microservices processing card transactions at very high volume, on Kubernetes and cloud, where any slowdown means lost revenue.',
                 did='Led end-to-end performance engineering using LoadRunner (C, manual correlation) and JMeter in CI/CD. Planned capacity for high-criticality services, and diagnosed bottlenecks across .NET, SQL Server and Postgres.',
                 outcome='Agreed benchmarks for each service, clear root-cause and tuning advice for developers, and a testing team mentored in AI-assisted workflows.'),
    'anz': dict(tag='Banking', client='ANZ', when='2015 to 2022',
                title='Resilient digital onboarding for credit cards and loans',
                challenge='Customer-facing ANZ Apply, Credit Card and Personal Loan platforms had to stay fast and available through peak demand and partial failures.',
                did='Led performance testing across multiple programmes, covering workload modelling, load, endurance and chaos/failure-injection testing. Introduced k6 and drove its adoption, and integrated performance testing into CI/CD.',
                outcome='Every release passes a performance quality gate, and the team now uses modern open-source tooling alongside JMeter and LoadRunner.'),
    'nab': dict(tag='Banking', client='NAB', when='2022',
                title='Back-end and front-end performance for online banking',
                challenge='Online banking, personal loan and credit card journeys needed SLA sign-off on a tight delivery timeline.',
                did='Wrote Gatling simulations for server-side load, plus client-side analysis of DOM load, first contentful paint and full render to isolate front-end bottlenecks.',
                outcome='A full picture of performance from server to screen, with tuning recommendations delivered within the release window.'),
}

SERVICES = [
    dict(
        slug='performance-testing', icon='⚡', name='Performance &amp; load testing', need='Performance &amp; load testing',
        specialty=True,
        title='Performance and load testing',
        h1='Know your system will hold up <span class="hl">before your users find out.</span>',
        lead='Load, stress, soak and spike testing with k6, JMeter, LoadRunner and Gatling, plus root-cause analysis with Dynatrace and Grafana. Twelve years of it, for banks, a global payments network and a national lottery.',
        summary='Load, stress, soak and spike testing with k6, JMeter, LoadRunner and Gatling, and root-cause analysis with Dynatrace and Grafana.',
        problems=[
            ('A big launch, sale or campaign is coming', 'and nobody knows how many users the system can really take.'),
            ('It slows down at peak', 'and the team is guessing whether it\'s the database, the code or the infrastructure.'),
            ('Load tests exist but nobody trusts them', 'because the workload doesn\'t look like real traffic, or the scripts break every release.'),
            ('Performance is checked once a year', 'instead of on every deployment, so regressions reach production.'),
        ],
        deliverables=[
            ('📈', 'Workload model', 'Built from your real traffic and growth forecast: which journeys, how many users, what arrival rate and what peak.'),
            ('🧪', 'Load, stress, soak and spike tests', 'Scripted in the tool that fits: k6 for modern pipelines, JMeter, LoadRunner or Gatling where you already use them.'),
            ('🔎', 'Bottlenecks traced to root cause', 'Dynatrace, Grafana and logs during every run, so findings point at the slow query, the leak or the exhausted pool.'),
            ('🚦', 'A performance gate in CI', 'Thresholds on p95 latency and error rate that stop a slow build before it ships.'),
            ('📝', 'A go/no-go report', 'Capacity headroom, risks and fixes in plain English for managers, with the detail developers need.'),
        ],
        cases=['tlc', 'visa', 'anz', 'nab'],
        highlights=[
            'Load, stress, soak and endurance tests for Powerball, Saturday Lotto, Oz Lotto and Keno, with distributed execution across multiple load injectors.',
            'Capacity planning and benchmarks for high-criticality Visa payment services.',
            'Chaos and failure-injection testing on ANZ\'s digital onboarding platforms.',
            'Bottlenecks found with Dynatrace that traditional monitoring missed: slow Oracle SQL, memory leaks and GC pressure.',
        ],
        steps=[
            ('Model', 'Agree the journeys, volumes and SLAs from your analytics and forecast.'),
            ('Script', 'Build version-controlled tests with realistic data, think time and correlation.'),
            ('Run &amp; diagnose', 'Ramp to peak and beyond while watching APM, infrastructure and logs.'),
            ('Report &amp; gate', 'Go/no-go report, tuning advice, and a gate in your pipeline.'),
        ],
        tools=['k6', 'JMeter', 'LoadRunner / LRE', 'Gatling', 'TruClient', 'Dynatrace', 'Grafana + InfluxDB', 'Kibana', 'Splunk', 'New Relic', 'GitLab CI', 'Jenkins', 'Kubernetes'],
        plan=('Go-live load test', 'Fixed scope · 1–2 weeks', 'Workload model, load/stress/soak tests at your peak, bottlenecks traced to root cause and a go/no-go report.'),
        faq=[
            ('Can you test against production?', 'Usually not, and you rarely need to. I test a production-like environment and scale the results, and I\'ll tell you plainly where the environment differs and what that means for the numbers.'),
            ('Which tool will you use?', 'The one that fits your team. k6 is my default for new work because it lives in your repo and your pipeline. If you already have JMeter or LoadRunner scripts, I\'ll build on them.'),
            ('How long does a load test take?', 'A focused go-live test is usually one to two weeks: a few days to model and script, then runs, diagnosis and the report.'),
            ('Do you only find problems or also help fix them?', 'Both. I trace slowdowns to the query, endpoint or setting behind them and work with your developers on the fix, then re-test.'),
        ],
        related_links=[('/tools/', 'Free performance calculators'), ('/interview-prep/performance-testing/', 'Performance testing interview prep')],
    ),
    dict(
        slug='test-automation', icon='🎭', name='Test automation with Playwright', need='Automation setup',
        title='Test automation with Playwright',
        h1='Automated tests that run on every pull request, <span class="hl">and that your team trusts.</span>',
        lead='Fast, maintainable UI and API test suites in Playwright that run in your pipeline. Fewer flaky tests, fewer manual regression cycles, faster releases.',
        summary='Fast, maintainable UI and API test suites that run on every pull request.',
        problems=[
            ('Every release needs days of manual regression', 'and it\'s still the step that gets cut when the deadline is close.'),
            ('There are automated tests, but they\'re flaky', 'so people re-run them until they pass and stop believing the results.'),
            ('Bugs come back', 'because nothing checks the journeys that broke last time.'),
            ('Nobody owns the test code', 'so it rots after the person who wrote it leaves.'),
        ],
        deliverables=[
            ('🎭', 'Playwright suite for your key journeys', 'Sign-up, login, checkout or whatever earns you money, across Chromium, Firefox and WebKit.'),
            ('🔌', 'API tests alongside the UI', 'Faster, more stable checks for the logic behind the screens.'),
            ('⚙️', 'Runs in your pipeline', 'GitHub Actions, GitLab CI or Jenkins, on every pull request, with reports and traces when something fails.'),
            ('🧹', 'Built not to be flaky', 'Stable locators, isolated test data and no fixed waits.'),
            ('📘', 'Docs and handover', 'So your developers can add tests in the same style after I\'ve gone.'),
        ],
        cases=['tlc', 'anz'],
        highlights=[
            'Melbourne Deal Finder: a Playwright scraper that runs every morning on a GitHub Actions schedule and publishes its own results page. <a href="/projects/deal-finder/">See it live →</a>',
            'A test framework adopted as the standard across engineering squads at The Lottery Corporation, running in GitLab CI on every deployment.',
            'Test code kept in Git and reviewed like application code, at Visa, ANZ and The Lottery Corporation.',
        ],
        steps=[
            ('Pick the journeys', 'Agree which flows matter most and what "done" looks like.'),
            ('Build the framework', 'Project structure, test data, fixtures and the first tests.'),
            ('Wire into CI', 'Run on every pull request with reports, traces and screenshots.'),
            ('Hand over', 'Docs and a walkthrough so your team owns it.'),
        ],
        tools=['Playwright', 'TypeScript / JavaScript', 'REST APIs', 'OpenAPI / Swagger', 'GitHub Actions', 'GitLab CI/CD', 'Jenkins', 'Docker', 'GitHub Copilot'],
        plan=('Automation setup', 'Fixed scope · 1–3 weeks', 'Playwright UI and API suite for key journeys, running in your CI, with docs and handover.'),
        faq=[
            ('Why Playwright?', 'It\'s fast, tests every major browser engine, waits for the page by itself (the biggest cause of flaky tests) and records traces that make failures easy to debug.'),
            ('We already have Selenium or Cypress tests. Do we have to start again?', 'No. I can stabilise what you have, or move the most valuable tests across first and retire the rest over time.'),
            ('Will my developers be able to maintain it?', 'That\'s the point. It\'s written in TypeScript, in your repo, with docs and a handover session.'),
        ],
        related_links=[('/projects/deal-finder/', 'Melbourne Deal Finder (Playwright project)')],
    ),
    dict(
        slug='api-testing', icon='🔌', name='API testing', need='API testing',
        title='API testing',
        h1='APIs that behave correctly, <span class="hl">even when the input doesn\'t.</span>',
        lead='Functional, negative, contract and integration testing of REST APIs and microservices with Postman and Playwright, generated from your OpenAPI or Swagger specs.',
        summary='Functional, negative, contract and integration testing of REST APIs and microservices.',
        problems=[
            ('Your front end and back end break each other', 'because nobody checks that the API still matches what the app expects.'),
            ('Only the happy path is tested', 'so bad input, expired tokens and timeouts are found by customers.'),
            ('Integrations with partners fail in production', 'with errors nobody saw in testing.'),
        ],
        deliverables=[
            ('📄', 'Tests generated from your spec', 'Your OpenAPI or Swagger file becomes typed clients and a test for every endpoint.'),
            ('🚫', 'Negative and edge cases', 'Missing fields, wrong types, bad auth, limits and error codes.'),
            ('🤝', 'Contract checks', 'Catch a breaking change before the app that depends on it does.'),
            ('⚙️', 'Runs in your pipeline', 'On every pull request, with clear failure reports.'),
        ],
        cases=['tlc', 'visa'],
        highlights=[
            'Pioneered OpenAPI-driven code generation at The Lottery Corporation: Swagger specs turned into typed API clients and service wrappers.',
            'Validated core banking and payment processing APIs at Visa, including token handling and correlation.',
            'Dynamic token handling with custom pre-processors for ANZ\'s API test scripts.',
        ],
        steps=[
            ('Read the spec', 'Map endpoints, auth and the business rules behind them.'),
            ('Generate &amp; write', 'Typed clients from the spec, then positive, negative and contract tests.'),
            ('Automate', 'Run them in CI against every build.'),
            ('Report', 'A clear list of defects and gaps, and tests your team keeps.'),
        ],
        tools=['REST APIs', 'OpenAPI / Swagger', 'Postman', 'Playwright', 'k6', 'JavaScript / TypeScript', 'Java', 'Python', 'Mountebank', 'CA LISA'],
        plan=('Test &amp; bug report', 'Fixed price · a few days', 'A focused test of your API with a prioritised defect report, or an automated suite as part of an automation setup.'),
        faq=[
            ('We don\'t have an OpenAPI spec. Can you still help?', 'Yes. I can work from your docs, a Postman collection or recorded traffic, and I can write the spec with you as I go.'),
            ('Can you test APIs that depend on third parties?', 'Yes. Service virtualisation (Mountebank, CA LISA) lets me fake a partner\'s API so tests don\'t depend on it being up.'),
        ],
        related_links=[],
    ),
    dict(
        slug='manual-testing', icon='🧪', name='Manual &amp; functional testing', need='Test &amp; bug report',
        title='Manual and functional testing',
        h1='A fresh pair of expert eyes <span class="hl">before your customers see it.</span>',
        lead='Test plans, test cases from your requirements, exploratory, regression, cross-browser and mobile testing, and UAT support. Clear, reproducible bug reports your developers can act on.',
        summary='Test plans, exploratory, regression, cross-browser and mobile testing, and UAT support.',
        problems=[
            ('Launch is close and nobody has tested it end to end', 'only the pieces each developer built.'),
            ('Bug reports come back as "can\'t reproduce"', 'because they don\'t say what was done, on what, with what data.'),
            ('It works on the developer\'s laptop', 'but not on the phone or browser your customers actually use.'),
        ],
        deliverables=[
            ('🗺️', 'A test plan and test cases', 'Written from your requirements and user journeys, kept in Jira/Zephyr or a simple sheet.'),
            ('🧭', 'Exploratory testing', 'Structured sessions that find what scripted tests miss.'),
            ('📱', 'Cross-browser and mobile checks', 'On the browsers and devices your customers use.'),
            ('🐞', 'Bug reports developers love', 'Steps, expected and actual results, screenshots and severity.'),
            ('✅', 'UAT support and sign-off', 'Help your business users test and agree it\'s ready.'),
        ],
        cases=['anz', 'nab'],
        highlights=[
            'Defects tracked and test artefacts managed in Jira and Confluence at Visa.',
            'Walkthroughs, workshops and release-readiness reporting for technical and non-technical stakeholders at ANZ, Visa and The Lottery Corporation.',
            'Client-side testing at NAB: page load and rendering checks that isolate front-end problems.',
        ],
        steps=[
            ('Understand', 'Your product, users and the risks that worry you most.'),
            ('Plan', 'Test cases and exploratory charters, prioritised by risk.'),
            ('Test', 'Run them, log clear defects as I go, and re-test fixes.'),
            ('Report', 'A plain-English summary and a go/no-go call.'),
        ],
        tools=['Test planning', 'Test case design', 'Exploratory', 'Regression', 'Cross-browser', 'UAT', 'Jira', 'Zephyr', 'Confluence'],
        plan=('Test &amp; bug report', 'Fixed price · a few days', 'A functional and exploratory test of your app with cross-browser and mobile checks and a prioritised bug report.'),
        faq=[
            ('Isn\'t manual testing out of date?', 'Automation checks what you already know can break. A person exploring the product finds what nobody thought of. You need both, in the right proportion.'),
            ('How quickly can you start?', 'Usually within a few days. A fixed-price test pass takes a few days from start to report.'),
        ],
        related_links=[],
    ),
    dict(
        slug='ci-cd-quality-gates', icon='🚦', name='CI/CD quality gates', need='CI/CD quality gates',
        title='CI/CD quality gates',
        h1='Stop broken or slow builds <span class="hl">before they reach production.</span>',
        lead='Automated functional, API and performance checks in GitHub Actions, GitLab CI or Jenkins, with clear pass/fail rules your whole team agrees on.',
        summary='Automated functional, API and performance checks in GitHub Actions, GitLab CI or Jenkins.',
        problems=[
            ('Tests exist but run "when someone remembers"', 'so problems surface days after the change that caused them.'),
            ('A release went out slower than the last one', 'and nobody noticed until customers did.'),
            ('Pipelines are green but meaningless', 'because the checks don\'t fail on the things that matter.'),
        ],
        deliverables=[
            ('⚙️', 'Tests wired into your pipeline', 'Functional, API and performance stages in GitHub Actions, GitLab CI or Jenkins.'),
            ('🎯', 'Agreed pass/fail rules', 'Error rate, p95 latency and test results as thresholds, not opinions.'),
            ('📊', 'Dashboards and reports', 'Grafana or pipeline reports so trends are visible, not just today\'s result.'),
            ('📘', 'Docs and handover', 'How to change a threshold, add a test or investigate a failure.'),
        ],
        cases=['tlc', 'anz', 'visa'],
        highlights=[
            'Automated performance regression runs on every deployment in GitLab CI at The Lottery Corporation.',
            'Performance quality gates at every release at ANZ.',
            'JMeter tests integrated into CI/CD pipelines at Visa.',
        ],
        steps=[
            ('Review', 'Your pipeline, tests and what has slipped through before.'),
            ('Agree the rules', 'Thresholds and what blocks a release.'),
            ('Build', 'Pipeline stages, reports and dashboards.'),
            ('Hand over', 'Docs and a walkthrough for your team.'),
        ],
        tools=['GitHub Actions', 'GitLab CI/CD', 'GitLab Runners', 'Jenkins', 'Docker', 'Kubernetes', 'Terraform', 'k6', 'Playwright', 'Grafana'],
        plan=('Automation setup', 'Fixed scope · 1–3 weeks', 'Tests for your key journeys running automatically in CI, with optional load-test gate and handover.'),
        faq=[
            ('Will this slow our pipeline down?', 'Fast checks run on every pull request; heavier load tests run on merge or nightly. You get safety without the wait.'),
            ('Which CI tools do you work with?', 'GitHub Actions, GitLab CI/CD and Jenkins, with Docker and Kubernetes.'),
        ],
        related_links=[],
    ),
    dict(
        slug='qa-strategy', icon='🧭', name='QA strategy &amp; setup', need='QA strategy &amp; setup',
        title='QA strategy and setup',
        h1='A testing process that fits your team, <span class="hl">not a textbook.</span>',
        lead='No QA process yet, or one that has grown messy? I\'ll set one up: test strategy, Jira/Zephyr workflows, release checklists and quality reporting, sized to suit your team.',
        summary='Test strategy, Jira/Zephyr workflows, release checklists and quality reporting.',
        problems=[
            ('Nobody is sure what "tested" means', 'so every release is a judgement call.'),
            ('You\'re hiring your first tester', 'and want the process ready before they start.'),
            ('Performance and reliability are no one\'s job', 'until there\'s an outage.'),
        ],
        deliverables=[
            ('🧭', 'Test strategy', 'What gets tested, how, by whom and when, matched to your risks and budget.'),
            ('🗂️', 'Workflows in your tools', 'Jira/Zephyr set up for test cases, defects and releases.'),
            ('✅', 'Release checklist', 'A short, agreed definition of ready to ship.'),
            ('📈', 'Non-functional requirements', 'Benchmarks and acceptance criteria for speed, capacity and resilience.'),
            ('👥', 'Coaching', 'Mentoring for your developers or new testers.'),
        ],
        cases=['visa', 'tlc'],
        highlights=[
            'Defined benchmarks, SLAs and non-functional acceptance criteria with delivery stakeholders at Visa and The Lottery Corporation.',
            'Mentored the wider testing team on best practices and AI-assisted workflows at Visa.',
            'Facilitated workshops and walkthroughs, and translated results into risk and release-readiness evidence.',
        ],
        steps=[
            ('Listen', 'Interview the team and look at recent releases and incidents.'),
            ('Design', 'A strategy and workflow sized to your team.'),
            ('Set up', 'Configure the tools, templates and checklists.'),
            ('Coach', 'Run the first releases with you, then step back.'),
        ],
        tools=['Jira', 'Zephyr', 'Confluence', 'Test strategy', 'Workload modelling', 'Release readiness', 'SRE practices'],
        plan=('Ongoing QA partner', 'Hourly, part-time or full-time contract', 'Join your sprints as your tester, with release sign-off and quality reporting.'),
        faq=[
            ('We\'re a small team. Is this overkill?', 'It\'s sized to you. For a small team that might be a one-page strategy and a ten-line release checklist.'),
            ('Can you also do the testing?', 'Yes. Many clients start with strategy and keep me on as their tester.'),
        ],
        related_links=[],
    ),
]

HEADER = '''  <header class="nav">
    <div class="wrap nav-inner">
      <a class="brand" href="/"><span class="logo" aria-hidden="true"></span>Pawan Sinha</a>
      <nav id="site-menu" aria-label="Main">
        <a href="/#services" aria-current="page">Services</a>
        <a href="/#work">Work</a>
        <a href="/#resources">Resources</a>
        <a href="/blog/">Blog</a>
        <a href="/#contact" class="btn btn-small">Hire me</a>
      </nav>
      <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-menu" aria-label="Open menu"><span></span></button>
    </div>
  </header>'''

FOOTER = f'''  <footer class="site-footer">
    <div class="wrap footer-grid">
      <div class="footer-about">
        <a class="brand" href="/"><span class="logo" aria-hidden="true"></span>Pawan Sinha</a>
        <p>Software testing and performance engineering for teams that can't afford to ship bugs. Melbourne, Australia. Remote, hybrid or on-site.</p>
        <p><a href="mailto:{EMAIL}">{EMAIL}</a> · <a href="{LINKEDIN}" target="_blank" rel="noopener">LinkedIn</a></p>
      </div>
      <div>
        <h2>Work with me</h2>
        <a href="/#services">Services</a>
        <a href="/#engage">Engagements</a>
        <a href="/#work">Case studies</a>
        <a href="/#contact">Book a free call</a>
      </div>
      <div>
        <h2>Free resources</h2>
        <a href="/interview-prep/performance-testing/">Interview prep</a>
        <a href="/tools/">Calculators</a>
        <a href="/blog/">Blog</a>
        <a href="/blog/feed.xml">RSS feed</a>
      </div>
      <div>
        <h2>Built by me</h2>
        <a href="/#projects">Projects</a>
        <a href="/projects/deal-finder/">Melbourne Deal Finder</a>
      </div>
    </div>
    <div class="wrap footer-bottom">
      <p>© <span data-year>2026</span> Pawan Sinha · QA &amp; Test Automation Engineer</p>
      <p>ABN 43 627 514 346</p>
    </div>
  </footer>'''


def plain(s):
    """Text without tags or entities, for meta tags and JSON-LD."""
    return unescape(re.sub(r'<[^>]+>', '', s))


def mailto(subject, body=''):
    return f'mailto:{EMAIL}?subject={quote(subject)}' + (f'&amp;body={quote(body)}' if body else '')


def case_html(key):
    c = CASES[key]
    return f'''          <article class="case">
            <div class="case-meta">
              <span class="tag">{c["tag"]}</span>
              <h3>{c["client"]}</h3>
              <p class="muted">{c["when"]}</p>
            </div>
            <div class="case-body">
              <h4>{c["title"]}</h4>
              <p><strong>Challenge:</strong> {c["challenge"]}</p>
              <p><strong>What I did:</strong> {c["did"]}</p>
              <p><strong>Outcome:</strong> {c["outcome"]}</p>
            </div>
          </article>'''


def page(s):
    url = f'{SITE}/services/{s["slug"]}/'
    name = plain(s['name'])
    desc = plain(s['summary']) + ' Melbourne-based, remote across Australia. Book a free 30-minute call.'
    brief = f'/?need={quote(plain(s["need"]))}#contact'
    ld = {
        '@context': 'https://schema.org',
        '@graph': [
            {'@type': 'Service', 'name': name, 'serviceType': name, 'description': plain(s['lead']), 'url': url,
             'areaServed': ['AU', 'Worldwide'],
             'provider': {'@type': 'Person', 'name': 'Pawan Sinha', 'url': SITE + '/', 'sameAs': [LINKEDIN]}},
            {'@type': 'BreadcrumbList', 'itemListElement': [
                {'@type': 'ListItem', 'position': 1, 'name': 'Home', 'item': SITE + '/'},
                {'@type': 'ListItem', 'position': 2, 'name': 'Services', 'item': SITE + '/#services'},
                {'@type': 'ListItem', 'position': 3, 'name': name, 'item': url}]},
            {'@type': 'FAQPage', 'mainEntity': [
                {'@type': 'Question', 'name': plain(q), 'acceptedAnswer': {'@type': 'Answer', 'text': plain(a)}} for q, a in s['faq']]},
        ],
    }
    problems = '\n'.join(f'          <li><strong>{a}</strong> {b}</li>' for a, b in s['problems'])
    deliverables = '\n'.join(
        f'''        <article class="card">
          <div class="icon">{i}</div>
          <h3>{t}</h3>
          <p>{d}</p>
        </article>''' for i, t, d in s['deliverables'])
    highlights = '\n'.join(f'          <li>{h}</li>' for h in s['highlights'])
    cases = '\n'.join(case_html(k) for k in s['cases'])
    steps = '\n'.join(f'        <li><span>{n:02d}</span><h3>{t}</h3><p>{d}</p></li>' for n, (t, d) in enumerate(s['steps'], 1))
    tools = ''.join(f'<li>{t}</li>' for t in s['tools'])
    faq = '\n'.join(f'''        <details>
          <summary>{q}</summary>
          <p>{a}</p>
        </details>''' for q, a in s['faq'])
    plan_name, plan_sub, plan_desc = s['plan']
    others = '\n'.join(
        f'        <a class="svc-other" href="/services/{o["slug"]}/"><span aria-hidden="true">{o["icon"]}</span>{o["name"]}</a>'
        for o in SERVICES if o is not s)
    related = ''.join(f'<li><a href="{h}">{t} →</a></li>' for h, t in s['related_links'])
    related = f'\n        <ul class="svc-related">{related}</ul>' if related else ''

    return f'''<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{escape(s["title"])} — Pawan Sinha, Melbourne</title>
  <meta name="description" content="{escape(desc)}">
  <meta property="og:title" content="{escape(s["title"])} — Pawan Sinha">
  <meta property="og:description" content="{escape(desc)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="{url}">
  <meta property="og:image" content="{SITE}/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:site_name" content="Pawan Sinha">
  <meta property="og:locale" content="en_AU">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="canonical" href="{url}">
  <meta name="theme-color" content="#2557d6">
  <script type="application/ld+json">{json.dumps(ld, ensure_ascii=False)}</script>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%232557d6'/><path d='M7 22l6-7 5 4 7-10' stroke='white' stroke-width='3' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles.css">
  <link rel="stylesheet" href="/chat.css">
</head>
<body>
  <!-- Generated by services/build.py. Edit the data there, not this file. -->
{HEADER}

  <main>
    <section class="hero svc-hero">
      <div class="wrap">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span aria-hidden="true">/</span><a href="/#services">Services</a><span aria-hidden="true">/</span><span aria-current="page">{s["name"]}</span></nav>
        <p class="eyebrow">{s["icon"]} {s["name"]}{' · my specialty' if s.get('specialty') else ''}</p>
        <h1>{s["h1"]}</h1>
        <p class="lead">{s["lead"]}</p>
        <div class="cta">
          <a class="btn" href="{BOOKING}" target="_blank" rel="noopener" data-track="svc-book-{s["slug"]}">Book a free 30-min call</a>
          <a class="btn btn-ghost" href="{brief}" data-track="svc-brief-{s["slug"]}">Send me your project</a>
        </div>
        <ul class="facts">
          <li>12+ years in testing</li>
          <li>ANZ · NAB · Visa · The Lottery Corporation</li>
          <li>Melbourne · remote across Australia</li>
        </ul>
      </div>
    </section>

    <section class="wrap section">
      <div class="why">
        <div>
          <p class="eyebrow">Sound familiar?</p>
          <h2>Where I can help</h2>
        </div>
        <ul class="ticks svc-problems">
{problems}
        </ul>
      </div>
    </section>

    <section class="section alt">
      <div class="wrap">
        <p class="eyebrow">What you get</p>
        <h2>How I help</h2>
        <div class="grid">
{deliverables}
        </div>
      </div>
    </section>

    <section class="wrap section">
      <p class="eyebrow">Experience</p>
      <h2>Where I've done this</h2>
      <ul class="ticks svc-highlights">
{highlights}
      </ul>
      <div class="cases">
{cases}
      </div>
    </section>

    <section class="section alt">
      <div class="wrap">
        <p class="eyebrow">How we'll work</p>
        <h2>From first call to handover</h2>
        <ol class="steps">
{steps}
        </ol>
        <h3 class="svc-tools-h">Tools I use for this</h3>
        <ul class="chips">{tools}</ul>
      </div>
    </section>

    <section class="wrap section">
      <div class="svc-split">
        <div>
          <p class="eyebrow">Ways to engage</p>
          <h2>Start small or bring me in for the long run</h2>
          <article class="card plan svc-plan">
            <h3>{plan_name}</h3>
            <p class="plan-sub">{plan_sub}</p>
            <p>{plan_desc}</p>
            <a class="btn" href="{brief}">Ask about this</a>
          </article>
          <p class="svc-note">Not sure yet? <a href="/?need=Free%20QA%20health%20check#contact">Get a free QA health check</a>, or see <a href="/#engage">all the ways to work together</a>.</p>{related}
        </div>
        <div>
          <p class="eyebrow">Questions</p>
          <h2>Common questions</h2>
          <div class="faq">
{faq}
          </div>
        </div>
      </div>
    </section>

    <section class="contact">
      <div class="wrap contact-inner">
        <h2>Let's talk about your project</h2>
        <p>Pick whichever suits you. I reply within one business day.</p>
        <div class="svc-options">
          <a class="svc-option" href="{BOOKING}" target="_blank" rel="noopener" data-track="svc-call-{s["slug"]}">
            <strong>Book a free 30-min call</strong><span>Talk through what you need. No obligation.</span>
          </a>
          <a class="svc-option" href="{brief}" data-track="svc-hire-{s["slug"]}">
            <strong>Hire me for a project</strong><span>Send a short brief and get a proposal.</span>
          </a>
          <a class="svc-option" href="{mailto("Interview request", "Hi Pawan,\n\nWe're hiring for: \nRole type (permanent / contract): \nA few times that suit us: ")}" data-track="svc-interview-{s["slug"]}">
            <strong>Hiring for a role?</strong><span>Invite me to interview for a permanent or contract position.</span>
          </a>
        </div>
        <p class="svc-direct"><a href="mailto:{EMAIL}">{EMAIL}</a> · <a href="{LINKEDIN}" target="_blank" rel="noopener">LinkedIn</a></p>
      </div>
    </section>

    <section class="wrap section svc-others">
      <p class="eyebrow">Other services</p>
      <div class="svc-other-list">
{others}
      </div>
    </section>
  </main>

{FOOTER}

  <script src="/chat.js" data-mode="services" data-endpoint="https://script.google.com/macros/s/AKfycbzvFENGzJ59oV9fx3Vc6CFzkjVpv5uFCx3Ob4zp_gfw0tNCXCI8TQYwJ9zQfkHQrARF/exec" data-booking-url="{BOOKING}" defer></script>
  <script src="/glow.js" defer></script>
  <script src="/menu.js" defer></script>
</body>
</html>
'''


def update_sitemap():
    path = OUT.parent / 'sitemap.xml'
    text = path.read_text(encoding='utf-8')
    block = '  <!-- services:start (generated by services/build.py) -->\n' + ''.join(
        f'  <url><loc>{SITE}/services/{s["slug"]}/</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>\n' for s in SERVICES
    ) + '  <!-- services:end -->'
    if '<!-- services:start' in text:
        text = re.sub(r'  <!-- services:start.*?<!-- services:end -->', lambda _: block, text, flags=re.S)
    else:
        text = text.replace('  <!-- blog:start', block + '\n  <!-- blog:start', 1)
    path.write_text(text, encoding='utf-8')


def main():
    for s in SERVICES:
        d = OUT / s['slug']
        d.mkdir(parents=True, exist_ok=True)
        (d / 'index.html').write_text(page(s), encoding='utf-8')
    update_sitemap()
    print(f'Built {len(SERVICES)} service pages in {OUT}')


if __name__ == '__main__':
    main()
