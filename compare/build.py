#!/usr/bin/env python3
"""Builds the load testing tool comparison pages from template.html.

Writes docs/compare/<slug>/index.html for every comparison in PAGES, the hub docs/compare/index.html, the tool picker
page docs/compare/tool-picker/index.html (its logic is the hand-written picker.js beside it, tested by
toolkit-tests/test-picker.js) and the compare block in docs/sitemap.xml.
All content lives in this file. Facts were checked on CHECKED (see the sources in each page's SOURCES list,
which are kept here for the record and not shown on the page). Re-check them before changing a version or licence.

Run:  python3 compare/build.py
"""
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'docs' / 'compare'
TEMPLATE = (Path(__file__).parent / 'template.html').read_text()
SITE = 'https://pawansinha.com.au'
CHECKED = 'November 2026'
DEFAULT_CODE_INTRO = ('The same simple test in both: load the home page, check for a 200 response, ramp up to 50 users over a minute, '
                      'then hold for three minutes with one second of think time.')

# ------------------------------------------------------------------ shared code samples
# The same test everywhere: GET the home page, check for a 200, ramp to 50 users over a minute, hold for 3 minutes.

K6 = """import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '1m', target: 50 },  // ramp up to 50 users
    { duration: '3m', target: 50 },  // hold
    { duration: '30s', target: 0 },  // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'], // fail the run if p95 >= 500 ms
    checks: ['rate>0.99'],
  },
};

export default function () {
  const res = http.get('https://test.example.com/');
  check(res, { 'status is 200': (r) => r.status === 200 });
  sleep(1); // think time
}"""

K6_NOTE = 'Run it with <code>k6 run script.js</code>. If a threshold fails, k6 exits with a non-zero code, so a CI pipeline fails too.'

JMX = """<!-- Trimmed: the parts of a .jmx file that matter -->
<ThreadGroup testclass="ThreadGroup" testname="Users">
  <intProp name="ThreadGroup.num_threads">50</intProp>
  <intProp name="ThreadGroup.ramp_time">60</intProp>
  <boolProp name="ThreadGroup.scheduler">true</boolProp>
  <stringProp name="ThreadGroup.duration">240</stringProp>
</ThreadGroup>
<hashTree>
  <HTTPSamplerProxy testclass="HTTPSamplerProxy" testname="Home page">
    <stringProp name="HTTPSampler.protocol">https</stringProp>
    <stringProp name="HTTPSampler.domain">test.example.com</stringProp>
    <stringProp name="HTTPSampler.path">/</stringProp>
    <stringProp name="HTTPSampler.method">GET</stringProp>
  </HTTPSamplerProxy>
  <hashTree>
    <ResponseAssertion testclass="ResponseAssertion" testname="Status is 200">
      <collectionProp name="Asserion.test_strings">
        <stringProp name="49586">200</stringProp>
      </collectionProp>
      <stringProp name="Assertion.test_field">Assertion.response_code</stringProp>
      <intProp name="Assertion.test_type">8</intProp>
    </ResponseAssertion>
  </hashTree>
  <ConstantTimer testclass="ConstantTimer" testname="Think time">
    <stringProp name="ConstantTimer.delay">1000</stringProp>
  </ConstantTimer>
</hashTree>"""

JMX_NOTE = ('You normally build this in the GUI: a <strong>Thread Group</strong> (50 threads, 60 s ramp-up, 240 s duration), '
            'an <strong>HTTP Request</strong> sampler, a <strong>Response Assertion</strong> on the response code and a '
            '<strong>Constant Timer</strong>. Run it without the GUI: <code>jmeter -n -t plan.jmx -l results.jtl -e -o report/</code>. '
            '(Yes, <code>Asserion</code> is spelt that way in JMeter itself.)')

GATLING = """import static io.gatling.javaapi.core.CoreDsl.*;
import static io.gatling.javaapi.http.HttpDsl.*;

import io.gatling.javaapi.core.*;
import io.gatling.javaapi.http.*;
import java.time.Duration;

public class HomePageSimulation extends Simulation {

  HttpProtocolBuilder httpProtocol =
      http.baseUrl("https://test.example.com");

  ScenarioBuilder users = scenario("Home page")
      .exec(http("Home page").get("/").check(status().is(200)))
      .pause(1); // think time

  {
    setUp(users.injectClosed(
            rampConcurrentUsers(0).to(50).during(Duration.ofMinutes(1)),
            constantConcurrentUsers(50).during(Duration.ofMinutes(3))))
        .protocols(httpProtocol)
        .assertions(
            global().responseTime().percentile(95.0).lt(500),
            global().successfulRequests().percent().gt(99.0));
  }
}"""

GATLING_NOTE = ('Gatling\'s Java SDK. You run it with the Maven or Gradle plugin (for example <code>mvn gatling:test</code>), '
                'and failed assertions fail the build. You get an HTML report at the end of every run.')

LOCUST = """from locust import HttpUser, task, constant

class Visitor(HttpUser):
    host = "https://test.example.com"
    wait_time = constant(1)  # think time

    @task
    def home(self):
        with self.client.get("/", catch_response=True) as r:
            if r.status_code != 200:
                r.failure(f"status {r.status_code}")

# Ramp to 50 users (1 new user a second), run for 4 minutes, no web UI:
#   locust -f locustfile.py --headless -u 50 -r 1 -t 4m"""

LOCUST_NOTE = ('The ramp is set on the command line here. For staged ramps written in code, subclass '
               '<code>LoadTestShape</code>. Failing the run on a response-time goal takes a few lines of Python in an event hook.')

VUGEN = """Action()
{
    int status;

    lr_start_transaction("home_page");

    web_url("home_page",
        "URL=https://test.example.com/",
        "Resource=0",
        "Mode=HTML",
        LAST);

    status = web_get_int_property(HTTP_INFO_RETURN_CODE);

    if (status == 200)
        lr_end_transaction("home_page", LR_PASS);
    else
        lr_end_transaction("home_page", LR_FAIL);

    lr_think_time(1);
    return 0;
}"""

VUGEN_NOTE = ('A VuGen script in C (Web HTTP/HTML protocol). The 50 users, the ramp and the duration are not in the script: '
              'you set them in the scenario schedule in the Controller (or in Enterprise Performance Engineering).')

ARTILLERY = """config:
  target: "https://test.example.com"
  phases:
    - name: Ramp up
      duration: 60
      arrivalRate: 1
      rampTo: 50     # new visitors per second
    - name: Hold
      duration: 180
      arrivalRate: 50
  plugins:
    expect: {}
    ensure: {}
  ensure:
    thresholds:
      - http.response_time.p95: 500  # fail the run if p95 > 500 ms

scenarios:
  - name: Home page
    flow:
      - get:
          url: "/"
          expect:
            - statusCode: 200
      - think: 1     # think time, in seconds"""

ARTILLERY_NOTE = ('Run it with <code>artillery run test.yml</code>. Artillery uses an open model: <code>arrivalRate</code> is new '
                  'virtual users per second, and each one runs the flow once and leaves. A visit here lasts about a second, so '
                  '50 arrivals a second keeps roughly 50 users busy (Little\'s Law). A failed <code>ensure</code> check gives a '
                  'non-zero exit code, so CI fails too.')

NEOLOAD = """# NeoLoad "as code" (YAML). A sketch: check the field
# names against the as-code docs for your NeoLoad version.
name: home-page
servers:
- name: site
  host: test.example.com
  scheme: https
user_paths:
- name: visitor
  actions:
    steps:
    - transaction:
        name: Home page
        steps:
        - request:
            server: site
            url: /
    - delay: 1s          # think time
populations:
- name: visitors
  user_paths:
  - name: visitor
scenarios:
- name: load-50
  populations:
  - name: visitors
    rampup_load:
      min_users: 5
      max_users: 50
      increment_users: 5
      increment_every: 6s
      duration: 4m"""

NEOLOAD_NOTE = ('Most NeoLoad tests are recorded and built in the NeoLoad GUI, with automatic correlation. The YAML "as code" '
                'format suits CI and can be combined with a GUI project. Response checks and SLA profiles (pass/fail '
                'thresholds) are added in the GUI or the same file. You run it from NeoLoad Web or the NeoLoad CLI.')

TAURUS = """# BlazeMeter runs JMeter, Gatling, Locust and more.
# This is Taurus YAML (BlazeMeter's open-source runner),
# which drives JMeter here.
execution:
- executor: jmeter
  concurrency: 50
  ramp-up: 1m
  hold-for: 3m
  scenario: home-page

scenarios:
  home-page:
    think-time: 1s
    requests:
    - url: https://test.example.com/
      assert:
      - contains:
        - "200"
        subject: http-code

reporting:
- module: passfail
  criteria:
  - p95>500ms for 30s, stop as failed
  - fail>1% for 30s, stop as failed"""

TAURUS_NOTE = ('Run it locally with <code>bzt test.yml</code>, or on BlazeMeter\'s load generators with '
               '<code>bzt test.yml -cloud</code> once your API key is set. You can also upload an existing .jmx file '
               'to BlazeMeter and set users, duration and locations in its web UI.')

K6_CLOUD = """import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '1m', target: 50 },
    { duration: '3m', target: 50 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],
    checks: ['rate>0.99'],
  },
  cloud: {
    name: 'Home page',
    // projectID: 1234567,   // your Grafana Cloud k6 project
    distribution: {
      sydney: { loadZone: 'amazon:au:sydney', percent: 100 },
    },
  },
};

export default function () {
  const res = http.get('https://test.example.com/');
  check(res, { 'status is 200': (r) => r.status === 200 });
  sleep(1);
}"""

K6_CLOUD_NOTE = ('The same k6 script as everywhere else, plus a <code>cloud</code> block that picks the load zone. '
                 'Log in with <code>k6 cloud login</code>, then <code>k6 cloud run script.js</code> runs it on Grafana\'s '
                 'load generators. <code>k6 run --out cloud script.js</code> runs it on your machine and streams the results '
                 'to Grafana Cloud. Check the current load zone names in the Grafana Cloud k6 docs.')

# ------------------------------------------------------------------ pages

PAGES = [
    dict(
        slug='k6-vs-jmeter', a='k6', b='JMeter',
        title='k6 vs JMeter: Which Load Testing Tool Should You Use?',
        desc='k6 vs JMeter compared honestly: scripting, licence, protocols, load models, CI/CD, reporting and resource use, with the same test written in both and tips for migrating.',
        ogdesc='An honest comparison of k6 and JMeter, with the same test in both tools and a migration checklist.',
        h1='k6 vs JMeter',
        lead='Both are free, open source and widely used. They suit different teams. JMeter is a mature Java tool with a GUI and a huge protocol list. k6 is a code-first tool that fits developers and CI pipelines. Here is how to choose.',
        pick_a=['Your team is happy writing JavaScript or TypeScript and wants tests in git, reviewed like any other code.',
                'You want pass/fail goals (thresholds) that fail a CI pipeline on their own.',
                'You mostly test HTTP APIs, websites, WebSockets or gRPC.',
                'You want to model real arrival rates (requests per second) without plugins.',
                'You already use Grafana, Prometheus or InfluxDB for monitoring.'],
        pick_b=['You test protocols beyond HTTP out of the box: JDBC databases, JMS queues, LDAP, FTP, mail or raw TCP.',
                'Your testers prefer building tests in a GUI and recording them with a proxy.',
                'You already have a large library of working .jmx plans and people who know them.',
                'You rely on a JMeter plugin that has no k6 equivalent.',
                'Your organisation only allows Apache-licensed tools (k6 is AGPL-3.0; check with your legal team).'],
        rows=[
            ('How you write tests', 'JavaScript, or TypeScript run directly (since k6 1.0, May 2025). Tests are plain code files.',
             'Built in a GUI and saved as XML (.jmx). Custom logic in Groovy (JSR223 elements).'),
            ('Licence and owner', 'Open source, AGPL-3.0. Made by Grafana Labs.', 'Open source, Apache 2.0. An Apache Software Foundation project.'),
            ('How load is generated', 'One Go binary. Each virtual user runs in its own lightweight JavaScript runtime.',
             'Java. Each virtual user is a JVM thread. Needs a Java runtime (Java 17 or later for JMeter 6; 5.6 ran on Java 8).'),
            ('Protocols', 'HTTP/1.1, HTTP/2, WebSockets, gRPC and real-browser tests (browser module). More through xk6 extensions written in Go.',
             'HTTP(S), JDBC, JMS, LDAP, FTP, SMTP/POP3/IMAP, TCP and Java out of the box. Many more through plugins.'),
            ('Load models', 'Executors for both closed (fixed users) and open (arrival-rate) models are built in.',
             'Thread groups are closed by default. Open models through the Open Model Thread Group, timers or plugins.'),
            ('CI/CD fit', 'Strong. CLI-first, thresholds set the exit code, easy to run in a container.',
             'Good, with work. Run in non-GUI mode; pass/fail on response-time goals needs a plugin, a wrapper or a script that reads the results.'),
            ('Results and reporting', 'End-of-test summary, a built-in web dashboard and outputs to Prometheus, InfluxDB, JSON, CSV and Grafana Cloud k6.',
             'An HTML dashboard report generated from the results file, GUI listeners, and a Backend Listener for InfluxDB or Graphite.'),
            ('Running at scale', 'Run several instances yourself, use the k6 Operator on Kubernetes, or the paid Grafana Cloud k6 service.',
             'Built-in remote (controller and load generator) mode, or a third-party cloud service.'),
            ('Learning curve', 'Easy for developers. No GUI: record a browser session as a HAR file and convert it, or write code.',
             'Easy to start in the GUI. Big plans get hard to review and merge, because XML diffs are hard to read.'),
            ('Resource use per virtual user', 'Usually lower: a load generator can run more users before it becomes the bottleneck.',
             'Usually higher, because every user is a thread with its own stack. Tune the JVM heap for big tests.'),
            ('Ecosystem', 'Younger but growing fast, with official extensions and close links to the Grafana stack.',
             'Over 20 years old. A large plugin library and a lot of people who already know it.'),
        ],
        code=[('k6 (JavaScript)', K6, K6_NOTE), ('JMeter (.jmx)', JMX, JMX_NOTE)],
        switch_h='Moving from JMeter to k6',
        switch=['<strong>Start with one journey that matters</strong>, such as login → search → checkout, not the whole suite.',
                'Convert the plan with the free <a href="/tools/jmeter-to-k6/">JMeter → k6 converter</a>. It maps thread groups, requests, CSV data, extractors and assertions, and flags what it couldn\'t convert.',
                'Map the concepts: extractors become JavaScript that reads the response, CSV Data Set becomes <code>SharedArray</code>, assertions become <code>check()</code>, and your SLAs become <code>thresholds</code>.',
                'Keep the same transaction (request) names, so you can compare old and new results side by side.',
                'Run both tools once at the same load against the same environment. The numbers should be close. If not, find out why before you switch.',
                'Grab single requests from the browser with the <a href="/tools/curl-to-k6/">curl → k6 converter</a>.',
                'Keep JMeter for anything k6 doesn\'t cover well (a JDBC or JMS test, for example). Using both tools is fine.'],
        faq=[('Is k6 better than JMeter?', 'Neither is better for everyone. k6 suits teams who write code and run tests in CI. JMeter suits teams who want a GUI or need protocols such as JDBC, JMS or LDAP without extensions.'),
             ('Is k6 free?', 'Yes. k6 is open source under the AGPL-3.0 licence and runs anywhere. Grafana Labs also sells a managed service, Grafana Cloud k6, for running large tests without your own load generators.'),
             ('Can k6 read my JMeter .jmx files?', 'No, k6 can\'t run .jmx files. You convert them into k6 scripts. A converter does most of the work, and you review the result.'),
             ('Does k6 support TypeScript?', 'Yes. Since k6 1.0 (May 2025) you can save a test as a .ts file and run it directly, with no build step.'),
             ('Which tool can generate more load from one machine?', 'k6 usually needs fewer resources per virtual user than JMeter. Whatever you use, watch the load generator\'s CPU and memory: if it\'s overloaded, your response times are wrong.')],
        sources=['https://grafana.com/blog/2025/05/07/grafana-k6-1.0-release/', 'https://github.com/grafana/k6 (README: AGPL-3.0)',
                 'https://github.com/apache/jmeter (README: Java 17)', 'https://jmeter.apache.org/changes.html'],
        hub='The modern code-first tool against the veteran with a GUI and the widest protocol list.',
    ),
    dict(
        slug='k6-vs-gatling', a='k6', b='Gatling',
        title='k6 vs Gatling: Which Load Testing Tool Should You Use?',
        desc='k6 vs Gatling compared: JavaScript vs Java, Kotlin, Scala and JavaScript SDKs, licence, load models, reports, CI/CD and scaling, with the same test written in both.',
        ogdesc='An honest comparison of k6 and Gatling, two code-first load testing tools, with the same test in both.',
        h1='k6 vs Gatling',
        lead='Both are code-first, open source and built for CI. The real differences are the language your team writes, the runtime (a Go binary or the JVM), the reports and the licence.',
        pick_a=['Your team writes JavaScript or TypeScript and doesn\'t want a JVM build.',
                'You want one small binary that runs anywhere, including a CI container.',
                'You already use Grafana, Prometheus or InfluxDB and want live results there.',
                'You need gRPC or real-browser tests built in.'],
        pick_b=['Your team works in Java, Kotlin or Scala and already uses Maven or Gradle.',
                'You want a detailed HTML report after every run without setting up anything else.',
                'Your organisation prefers the Apache 2.0 licence.',
                'You want precise open and closed injection profiles in a readable DSL.'],
        rows=[
            ('How you write tests', 'JavaScript, or TypeScript run directly (since k6 1.0).',
             'A DSL in Java, Kotlin or Scala. A JavaScript and TypeScript SDK was added in 2024 and also runs on the JVM.'),
            ('Licence and owner', 'Open source, AGPL-3.0. Made by Grafana Labs.', 'Open source, Apache 2.0. Made by Gatling Corp, which also sells Gatling Enterprise.'),
            ('How load is generated', 'One Go binary; each virtual user has its own lightweight JavaScript runtime.',
             'Runs on the JVM with non-blocking networking, so virtual users are not threads. Efficient at high concurrency.'),
            ('Protocols', 'HTTP/1.1, HTTP/2, WebSockets, gRPC and browser tests; more through xk6 extensions.',
             'HTTP, WebSocket, Server-Sent Events and JMS; more through plugins.'),
            ('Load models', 'Closed and open (arrival-rate) executors built in.', 'Open (injectOpen) and closed (injectClosed) injection profiles built in.'),
            ('CI/CD fit', 'Strong. Thresholds set the exit code.', 'Strong. Assertions fail the Maven, Gradle or npm build.'),
            ('Results and reporting', 'End-of-test summary, a web dashboard and outputs to Prometheus, InfluxDB, JSON and Grafana Cloud k6.',
             'A detailed static HTML report after every run. Live dashboards and run history are part of Gatling Enterprise.'),
            ('Running at scale', 'Run several instances yourself, the k6 Operator on Kubernetes, or the paid Grafana Cloud k6.',
             'Run several instances yourself, or the paid Gatling Enterprise (cloud or self-hosted load generators).'),
            ('Learning curve', 'Low setup: install one binary and write a script.', 'You need a JVM project set-up (or npm for the JavaScript SDK). The DSL reads well once you know it.'),
            ('Resource use per virtual user', 'Low.', 'Low. Both handle thousands of users per machine for typical HTTP tests; measure your own.'),
            ('Ecosystem', 'Grafana stack, official extensions and a large community.', 'Popular in JVM teams, with plugins and a long history.'),
        ],
        code=[('k6 (JavaScript)', K6, K6_NOTE), ('Gatling (Java)', GATLING, GATLING_NOTE)],
        switch_h='Moving between k6 and Gatling',
        switch=['Both use the same ideas, so a port is mostly translation: a k6 <code>default</code> function is a Gatling <code>scenario</code>, <code>stages</code> are injection steps, <code>check()</code> is <code>.check()</code> and thresholds are assertions.',
                'Watch the load model. A k6 <code>ramping-vus</code> test is a closed model, like Gatling\'s <code>injectClosed</code>. A k6 arrival-rate executor matches <code>injectOpen</code>.',
                'Keep request names identical so old and new reports line up.',
                'Run both once at the same load and compare percentiles before you retire the old tool.',
                'Start from a browser request with the <a href="/tools/curl-to-k6/">curl → k6 converter</a> if you\'re moving to k6.'],
        faq=[('Is Gatling free?', 'Yes. Gatling\'s open-source edition is free under Apache 2.0. Gatling Enterprise is a paid product that adds distributed load, live dashboards and team features.'),
             ('Can I write Gatling tests in JavaScript?', 'Yes. Gatling added a JavaScript and TypeScript SDK in 2024. The tests still run on the JVM.'),
             ('Which has better reports, k6 or Gatling?', 'Gatling gives you a full HTML report after every run with no set-up. k6 gives a summary and a web dashboard, and is strongest when you stream results into Grafana.'),
             ('Is k6 or Gatling faster?', 'Both are efficient load generators. Pick on language and workflow, then check the load generator\'s CPU stays well below its limit during your tests.')],
        sources=['https://github.com/gatling/gatling (Apache 2.0; Java, JavaScript, TypeScript, Kotlin, Scala)', 'https://docs.gatling.io',
                 'https://en.wikipedia.org/wiki/Gatling_(software) (JS/TS SDK 2024)', 'https://github.com/grafana/k6'],
        hub='Two code-first tools: JavaScript and a Go binary, or the JVM with a great HTML report.',
    ),
    dict(
        slug='k6-vs-locust', a='k6', b='Locust',
        title='k6 vs Locust: Which Load Testing Tool Should You Use?',
        desc='k6 vs Locust compared: JavaScript vs Python, licence, load models, protocols, CI/CD, the web UI and scaling, with the same test written in both.',
        ogdesc='An honest comparison of k6 and Locust, with the same test in JavaScript and Python.',
        h1='k6 vs Locust',
        lead='Locust is the Python load testing tool: tests are plain Python and you can steer a run from a web UI. k6 is JavaScript, built for CI. The language your team already uses is often the deciding factor.',
        pick_a=['You want pass/fail thresholds built in, so CI fails on its own.',
                'You need arrival-rate (open) load models built in.',
                'You want more load from fewer machines.',
                'You need gRPC, WebSockets or browser tests without writing your own client.'],
        pick_b=['Your team lives in Python, or the system has a Python client library you want to reuse.',
                'You want to change the number of users during a run from a web UI.',
                'You need to test an unusual protocol and are happy to write a small Python client for it.',
                'You want the MIT licence.'],
        rows=[
            ('How you write tests', 'JavaScript or TypeScript.', 'Plain Python classes. Any Python library can be used.'),
            ('Licence', 'Open source, AGPL-3.0 (Grafana Labs).', 'Open source, MIT.'),
            ('How load is generated', 'One Go binary that uses all CPU cores.',
             'Each user is a lightweight gevent greenlet. One Locust process uses one CPU core, so you run several worker processes to use a whole machine.'),
            ('Protocols', 'HTTP/1.1, HTTP/2, WebSockets, gRPC and browser tests; more through Go extensions.',
             'HTTP built in (HttpUser, and the faster FastHttpUser). Anything else you can call from Python, by writing a small client.'),
            ('Load models', 'Closed and open (arrival-rate) executors built in.',
             'Closed: a number of users with wait times. Custom shapes with a LoadTestShape class; constant throughput per user with constant_throughput.'),
            ('CI/CD fit', 'Strong. Thresholds set the exit code.', 'Good. Headless mode works in CI; failing on response-time goals needs a few lines of Python.'),
            ('Results and reporting', 'End-of-test summary, web dashboard, and outputs to Prometheus, InfluxDB, JSON and more.',
             'A live web UI with charts, plus CSV and HTML reports.'),
            ('Running at scale', 'Several instances, the k6 Operator on Kubernetes, or Grafana Cloud k6 (paid).', 'Built-in master and worker mode across machines.'),
            ('Learning curve', 'Easy for JavaScript developers.', 'Very easy for Python developers.'),
            ('Resource use per virtual user', 'Low.', 'Higher, because Python is slower per request. Plan for more worker processes for the same load.'),
            ('Ecosystem', 'Grafana stack and official extensions.', 'The whole Python ecosystem, plus community plugins.'),
        ],
        code=[('k6 (JavaScript)', K6, K6_NOTE), ('Locust (Python)', LOCUST, LOCUST_NOTE)],
        switch_h='Moving between k6 and Locust',
        switch=['A Locust <code>@task</code> maps to the k6 <code>default</code> function (or one scenario per task class), and <code>wait_time</code> maps to <code>sleep()</code>.',
                'Locust task weights become separate k6 scenarios, or a random choice inside the function.',
                'If you used Locust\'s web UI to find the breaking point by hand, write it as k6 <code>stages</code>, so every run is repeatable.',
                'Compare one run in each tool at the same load before you switch.',
                'Copy single requests from the browser with the <a href="/tools/curl-to-k6/">curl → k6 converter</a>.'],
        faq=[('Is Locust free?', 'Yes, Locust is open source under the MIT licence.'),
             ('Is Locust good for high load?', 'Yes, if you run enough worker processes. Each process uses one CPU core, so a big test needs several workers, often across machines. Watch the workers\' CPU.'),
             ('Can I change the load during a Locust test?', 'Yes. The web UI lets you change the number of users while the test runs. That\'s handy for exploring, but write the final test as code so it\'s repeatable.'),
             ('Which is easier, k6 or Locust?', 'Whichever matches your team\'s language. Python teams usually find Locust easier; JavaScript teams usually find k6 easier.')],
        sources=['https://github.com/locustio/locust (MIT, Python, gevent)', 'https://pypi.org/project/locust', 'https://github.com/grafana/k6'],
        hub='JavaScript and built-in thresholds, or Python and a live web UI.',
    ),
    dict(
        slug='jmeter-vs-loadrunner', a='JMeter', b='LoadRunner',
        title='JMeter vs LoadRunner: Which Load Testing Tool Should You Use?',
        desc='JMeter vs LoadRunner (OpenText Performance Engineering) compared: cost and licensing, protocols, scripting, correlation, analysis, CI/CD and scale.',
        ogdesc='An honest comparison of free JMeter and commercial LoadRunner, from someone who has used both in banking.',
        h1='JMeter vs LoadRunner',
        lead='LoadRunner is the long-standing commercial tool, now sold by OpenText under the Performance Engineering name. JMeter is the free, open-source alternative. The choice usually comes down to protocols, budget and support.',
        pick_a=['You mainly test websites and HTTP APIs.',
                'There is no licence budget, or you want to run tests on every build without counting virtual users.',
                'You want to run tests in CI pipelines and containers freely.',
                'Your team is comfortable supporting an open-source tool themselves.'],
        pick_b=['You must test Citrix, SAP GUI, Oracle Forms, RDP or terminal (mainframe) applications.',
                'You want automatic correlation and a vendor to call when something breaks.',
                'You need deep analysis that lines up response times with server monitors in one place.',
                'Your organisation already owns licences and has trained people.'],
        rows=[
            ('Cost and licence', 'Free and open source (Apache 2.0).',
             'Commercial (OpenText). Licensed in virtual-user bundles by protocol. A free Community licence includes 50 virtual users for most protocols.'),
            ('Product names', 'Apache JMeter.',
             'In 2025 OpenText renamed the range: LoadRunner Professional is now Professional Performance Engineering, LoadRunner Enterprise is Enterprise Performance Engineering, and LoadRunner Cloud is Core Performance Engineering.'),
            ('How you write tests', 'Built in a GUI, saved as XML (.jmx). Custom logic in Groovy.',
             'Recorded and edited in VuGen. Scripts are mostly C, with JavaScript and Java for some protocols.'),
            ('Protocols', 'HTTP(S), JDBC, JMS, LDAP, FTP, mail, TCP and Java, plus plugins.',
             'A very wide list, including Web HTTP/HTML, Citrix, SAP GUI, Oracle, RDP, terminal emulators, Java and .NET.'),
            ('Correlation (dynamic values)', 'Manual: add extractors (regex, JSON, boundary) yourself.', 'Automatic correlation rules in VuGen, plus manual functions.'),
            ('Results and analysis', 'An HTML dashboard report, listeners and a Backend Listener to InfluxDB or Graphite.',
             'The Analysis tool: graphs, merging and correlating results with server monitors, and report templates.'),
            ('Running at scale', 'Built-in remote mode, or a third-party cloud service.', 'Controller and load generators, or the Enterprise and cloud editions for teams.'),
            ('CI/CD fit', 'Good. Non-GUI mode runs anywhere Java runs.', 'Possible through OpenText plugins for common CI tools; licences and load generators need planning.'),
            ('Learning curve', 'Moderate. Lots of free tutorials.', 'Moderate to steep. Vendor training and certification exist.'),
            ('Support', 'Community: forums, mailing lists and plugins.', 'Vendor support from OpenText.'),
        ],
        code=[('JMeter (.jmx)', JMX, JMX_NOTE), ('LoadRunner VuGen (C)', VUGEN, VUGEN_NOTE)],
        switch_h='Moving off LoadRunner',
        switch=['<strong>List what you have first</strong>: scripts, protocols, how often each runs and who owns it. Anything on Citrix, SAP GUI or terminal protocols may need to stay on LoadRunner.',
                'There is no reliable automatic LoadRunner-to-JMeter converter. Re-record each journey (JMeter\'s HTTP(S) Test Script Recorder, or a browser HAR file) and rebuild the correlation.',
                'Keep the same transaction names, so the new results can be compared with your LoadRunner baselines.',
                'Run the old and new tests once at the same load. Investigate any gap before you switch.',
                'If you\'re choosing a new tool anyway, look at k6 too: you can convert JMeter plans later with the <a href="/tools/jmeter-to-k6/">JMeter → k6 converter</a>.'],
        faq=[('Is LoadRunner free?', 'Not for real use. OpenText includes a free Community licence of 50 virtual users for most protocols, which is fine for learning and small trials. Bigger tests need paid licences.'),
             ('What happened to LoadRunner?', 'Nothing has been discontinued. OpenText (which bought Micro Focus) renamed the products in 2025: LoadRunner Professional is now OpenText Professional Performance Engineering, Enterprise is Enterprise Performance Engineering and Cloud is Core Performance Engineering.'),
             ('Can JMeter replace LoadRunner?', 'For websites and HTTP APIs, usually yes. For Citrix, SAP GUI, Oracle Forms or terminal applications, usually not.'),
             ('Do banks still use LoadRunner?', 'Many large organisations still do, often alongside JMeter or k6 for newer HTTP and API work.')],
        sources=['https://blogs.opentext.com/what-happened-to-loadrunner-the-future-of-performance-engineering-at-opentext/',
                 'https://www.opentext.com/au/products/core-performance-engineering',
                 'https://admhelp.microfocus.com/lr/en/24.1/help/WebHelp/Content/License/R_License_Utility.htm (Community licence, 50 Vusers)',
                 'https://github.com/apache/jmeter'],
        hub='Free and open source, or commercial with the widest protocol list and vendor support.',
    ),
    dict(
        slug='jmeter-vs-gatling', a='JMeter', b='Gatling',
        title='JMeter vs Gatling: Which Load Testing Tool Should You Use?',
        desc='JMeter vs Gatling compared: GUI and XML vs code in Java, Kotlin, Scala or JavaScript, protocols, load models, reports, CI/CD and resource use.',
        ogdesc='An honest comparison of JMeter and Gatling, two free JVM load testing tools, with the same test in both.',
        h1='JMeter vs Gatling',
        lead='Both are free, run on the JVM and are licensed under Apache 2.0. JMeter is built in a GUI and saved as XML. Gatling tests are code. The deciding question is usually who writes and maintains the tests.',
        pick_a=['Your testers prefer a GUI and recording with a proxy over writing code.',
                'You need JDBC, JMS, LDAP, FTP, mail or raw TCP without extra work.',
                'You already have a library of .jmx plans and people who know them.',
                'You rely on a JMeter plugin with no Gatling equivalent.'],
        pick_b=['Your team writes Java, Kotlin or Scala (or JavaScript) and wants tests reviewed like any other code.',
                'You need thousands of users from one machine without heavy JVM tuning.',
                'You want a detailed HTML report after every run with nothing to set up.',
                'You want open and closed injection profiles in a readable DSL.'],
        rows=[
            ('How you write tests', 'Built in a GUI and saved as XML (.jmx). Custom logic in Groovy (JSR223 elements).',
             'Code: a DSL in Java, Kotlin or Scala, or the JavaScript and TypeScript SDK added in 2024.'),
            ('Licence and owner', 'Open source, Apache 2.0. An Apache Software Foundation project.',
             'Open source, Apache 2.0. Made by Gatling Corp, which also sells Gatling Enterprise.'),
            ('How load is generated', 'Each virtual user is a JVM thread, with its own stack.',
             'Non-blocking networking on the JVM, so virtual users are not threads.'),
            ('Protocols', 'HTTP(S), JDBC, JMS, LDAP, FTP, SMTP/POP3/IMAP, TCP and Java out of the box, many more through plugins.',
             'HTTP, WebSocket, Server-Sent Events and JMS, more through plugins.'),
            ('Load models', 'Thread groups are closed by default. Open models through the Open Model Thread Group, timers or plugins.',
             'Open (injectOpen) and closed (injectClosed) injection profiles built in.'),
            ('Recording', 'HTTP(S) Test Script Recorder (a proxy) built in.',
             'Gatling Recorder (proxy or HAR file import) generates a simulation you then tidy up.'),
            ('CI/CD fit', 'Good, with work. Non-GUI mode runs anywhere; pass/fail on response-time goals needs a plugin, a wrapper or a script that reads the results.',
             'Strong. Assertions fail the Maven, Gradle or npm build.'),
            ('Results and reporting', 'An HTML dashboard generated from the results file, GUI listeners, and a Backend Listener for InfluxDB or Graphite.',
             'A detailed static HTML report after every run. Live dashboards and run history are part of Gatling Enterprise.'),
            ('Running at scale', 'Built-in remote (controller and load generator) mode, or a hosted service such as BlazeMeter.',
             'Run several instances yourself, or the paid Gatling Enterprise.'),
            ('Code review and version control', 'XML diffs are hard to read, so reviews of big plans are painful.',
             'Plain code: diffs, reviews and refactoring work like any other project.'),
            ('Resource use per virtual user', 'Higher: one thread per user. Tune the JVM heap for big tests.',
             'Lower for typical HTTP tests. Measure your own.'),
        ],
        code=[('JMeter (.jmx)', JMX, JMX_NOTE), ('Gatling (Java)', GATLING, GATLING_NOTE)],
        switch_h='Moving from JMeter to Gatling',
        switch=['<strong>Port one journey first</strong>, the one that matters most, not the whole suite.',
                'Map the concepts: a Thread Group becomes a scenario plus an injection profile, extractors become <code>.check(...saveAs(...))</code>, CSV Data Set Config becomes a feeder, and assertions become <code>.check()</code> and global assertions.',
                'Decide the load model on purpose. A JMeter thread group is a closed model, like <code>injectClosed</code>. If real users arrive whatever the response time, use <code>injectOpen</code>.',
                'Keep request names identical so the two reports line up.',
                'Run both at the same load once and compare percentiles before you retire the JMeter plan.',
                'Keep JMeter for JDBC, LDAP or mail tests if Gatling has no good plugin for them. Using both is fine.'],
        faq=[('Is Gatling better than JMeter?', 'For teams that write code and run tests in CI, usually yes. For testers who want a GUI, or for protocols such as JDBC and LDAP, JMeter is often the better fit.'),
             ('Is Gatling free?', 'Yes. The open-source edition is free under Apache 2.0. Gatling Enterprise is a paid product that adds distributed load, live dashboards and team features.'),
             ('Can Gatling run JMeter .jmx files?', 'No. You rebuild the test in Gatling, by re-recording or by translating the plan by hand.'),
             ('Which uses fewer resources, JMeter or Gatling?', 'Gatling usually needs less CPU and memory per virtual user, because users are not threads. Whatever you use, watch the load generator\'s CPU during the test.')],
        sources=['https://github.com/apache/jmeter', 'https://github.com/gatling/gatling (Apache 2.0)', 'https://docs.gatling.io (recorder, injection profiles, JS SDK)'],
        hub='Both free and on the JVM: a GUI and XML, or code with a great HTML report.',
    ),
    dict(
        slug='jmeter-vs-neoload', a='JMeter', b='NeoLoad',
        title='JMeter vs NeoLoad: Which Load Testing Tool Should You Use?',
        desc='JMeter vs NeoLoad (Tricentis) compared: cost and licensing, protocols, recording and correlation, analysis, CI/CD, scale and support.',
        ogdesc='An honest comparison of free JMeter and commercial NeoLoad from Tricentis.',
        h1='JMeter vs NeoLoad',
        lead='NeoLoad is a commercial load testing tool, owned by Tricentis since it bought Neotys in 2021. JMeter is the free, open-source standard. Both are GUI-first. The choice comes down to protocols, how much time correlation costs you, and budget.',
        pick_a=['You mainly test websites and HTTP APIs.',
                'There is no licence budget, or you want to run tests freely in CI without counting virtual users.',
                'Your team is comfortable supporting an open-source tool and its plugins themselves.',
                'You need JDBC, LDAP, mail or raw TCP tests.'],
        pick_b=['You must test SAP GUI, Citrix or Oracle Forms.',
                'Recording and correlating complex web apps takes too long by hand, and automatic correlation would pay for itself.',
                'You want shared dashboards, run comparisons and APM integrations in one product.',
                'You want a vendor to call when something breaks, or you already use other Tricentis tools.'],
        rows=[
            ('Cost and licence', 'Free and open source (Apache 2.0).',
             'Commercial (Tricentis). Licensed by virtual users and features. Check Tricentis for current editions and trials.'),
            ('How you write tests', 'Built in a GUI and saved as XML (.jmx). Custom logic in Groovy.',
             'Recorded and built in a GUI. Custom logic in JavaScript actions. Tests can also be written as YAML ("as code").'),
            ('Correlation (dynamic values)', 'Manual: you add extractors (regex, JSON, boundary) yourself.',
             'Automatic correlation from frameworks and recorded responses, plus manual extractors.'),
            ('Protocols', 'HTTP(S), JDBC, JMS, LDAP, FTP, mail, TCP and Java, plus plugins.',
             'Web and APIs (including HTTP/2 and WebSocket), plus SAP GUI, Citrix and Oracle Forms, among others.'),
            ('Results and analysis', 'An HTML dashboard report, listeners, and a Backend Listener to InfluxDB or Graphite.',
             'NeoLoad Web: live dashboards, trends and run comparisons, shared across the team, with APM integrations such as Dynatrace.'),
            ('Running at scale', 'Built-in remote mode, or a hosted service such as BlazeMeter.',
             'Controller and load generators, on your own machines, in containers or in the cloud.'),
            ('CI/CD fit', 'Good. Non-GUI mode runs anywhere Java runs; pass/fail on response-time goals needs extra work.',
             'Good. A CLI and CI plugins run tests and fail builds on SLA thresholds; licences and load generators need planning.'),
            ('Learning curve', 'Moderate. Lots of free tutorials and people who know it.', 'Moderate. Vendor training is available; fewer free tutorials.'),
            ('Support', 'Community: forums, mailing lists and plugins.', 'Vendor support from Tricentis.'),
        ],
        code=[('JMeter (.jmx)', JMX, JMX_NOTE), ('NeoLoad as code (YAML, sketch)', NEOLOAD, NEOLOAD_NOTE)],
        switch_h='Moving between JMeter and NeoLoad',
        switch=['<strong>List what you have</strong>: scripts, protocols, how often each runs and who owns it. SAP GUI, Citrix and Oracle Forms tests are the hard ones to move to JMeter.',
                'There is no reliable automatic converter either way. Re-record each journey and rebuild the correlation. A browser HAR file is a good shared starting point.',
                'Keep the same transaction names, so new results can be compared with your old baselines.',
                'Run the old and new tests once at the same load and investigate any gap before you switch.',
                'Moving off a commercial tool for HTTP work anyway? Look at k6 too, and the <a href="/tools/jmeter-to-k6/">JMeter → k6 converter</a>.'],
        faq=[('Is NeoLoad free?', 'NeoLoad is commercial. Tricentis has offered trials and limited free editions over the years, so check its site for what is available now.'),
             ('Who owns NeoLoad?', 'Tricentis. It bought Neotys, the company that built NeoLoad, in 2021.'),
             ('Can JMeter replace NeoLoad?', 'For websites and HTTP APIs, usually yes, at the cost of more manual correlation. For SAP GUI, Citrix or Oracle Forms, usually not.'),
             ('Is NeoLoad only for web applications?', 'No. Besides websites and APIs it covers packaged-application protocols such as SAP GUI, Citrix and Oracle Forms, which is a common reason teams pay for it.')],
        sources=['https://www.tricentis.com/products/performance-testing-neoload', 'https://www.tricentis.com/news (Neotys acquisition, 2021)',
                 'https://documentation.tricentis.com/neoload/ (as-code, protocols, CLI)', 'https://github.com/apache/jmeter'],
        hub='Free and open source, or commercial with automatic correlation and SAP and Citrix support.',
    ),
    dict(
        slug='k6-vs-artillery', a='k6', b='Artillery',
        title='k6 vs Artillery: Which Load Testing Tool Should You Use?',
        desc='k6 vs Artillery compared: JavaScript vs YAML with Node.js hooks, licence, load models, browser tests, CI/CD, reporting and scaling on AWS.',
        ogdesc='An honest comparison of k6 and Artillery, two JavaScript-friendly load testing tools, with the same test in both.',
        h1='k6 vs Artillery',
        lead='Both suit JavaScript teams and CI pipelines. k6 tests are JavaScript code run by a Go engine. Artillery tests are YAML, with Node.js functions for custom logic, and it can spread a test across AWS for you.',
        pick_a=['You want tests as plain code, with logic, loops and helpers in one language.',
                'You want both closed (fixed users) and open (arrival-rate) models built in.',
                'You need gRPC built in, or want low resource use per virtual user.',
                'You already use Grafana, Prometheus or InfluxDB for monitoring.'],
        pick_b=['Your tests are mostly simple flows that read well as YAML, with a little JavaScript where needed.',
                'You want to reuse npm packages or Node.js code in your tests.',
                'You run on AWS and want the tool to fan a big test out over Lambda or Fargate for you.',
                'You test Socket.IO apps, or want Playwright browser tests in the same tool.'],
        rows=[
            ('How you write tests', 'JavaScript, or TypeScript run directly (since k6 1.0).',
             'YAML scenarios. Custom logic in JavaScript functions (a processor file), with npm packages available.'),
            ('Licence and owner', 'Open source, AGPL-3.0. Made by Grafana Labs.', 'Open source, MPL-2.0. Made by Artillery, which also sells Artillery Cloud.'),
            ('How load is generated', 'One Go binary; each virtual user has its own lightweight JavaScript runtime.',
             'Node.js. For big tests, Artillery can run the load from AWS Lambda or AWS Fargate.'),
            ('Protocols', 'HTTP/1.1, HTTP/2, WebSockets, gRPC and browser tests; more through xk6 extensions.',
             'HTTP, WebSocket and Socket.IO built in, Playwright browser tests, more through engines and plugins.'),
            ('Load models', 'Closed and open (arrival-rate) executors built in.',
             'Open by default: phases set how many new virtual users arrive per second. Each runs the scenario once. Loops in the flow make longer sessions.'),
            ('CI/CD fit', 'Strong. Thresholds set the exit code.', 'Strong. ensure checks set the exit code; there is an official Docker image.'),
            ('Results and reporting', 'End-of-test summary, a web dashboard and outputs to Prometheus, InfluxDB, JSON and Grafana Cloud k6.',
             'A terminal summary during and after the run, JSON output, Artillery Cloud dashboards, and plugins that publish metrics to tools such as Datadog and Prometheus.'),
            ('Running at scale', 'Several instances, the k6 Operator on Kubernetes, or the paid Grafana Cloud k6.',
             'Built-in runners on AWS Lambda and Fargate (you pay AWS), or several instances yourself.'),
            ('Learning curve', 'Easy for developers: it is just code.', 'Very easy for simple flows. Complex logic split between YAML and JavaScript can get awkward.'),
            ('Resource use per virtual user', 'Low.', 'Usually higher per request, as it runs on Node.js. Watch the load generator\'s CPU.'),
        ],
        code=[('k6 (JavaScript)', K6, K6_NOTE), ('Artillery (YAML)', ARTILLERY, ARTILLERY_NOTE)],
        switch_h='Moving between k6 and Artillery',
        switch=['Mind the load model first. Artillery phases are arrival rates, like k6\'s <code>ramping-arrival-rate</code> executor, not like <code>ramping-vus</code>.',
                'An Artillery scenario maps to a k6 scenario, <code>think</code> maps to <code>sleep()</code>, <code>capture</code> maps to reading the response in code, and <code>expect</code> or <code>ensure</code> maps to <code>check()</code> and thresholds.',
                'Processor functions become ordinary JavaScript in the k6 script. npm packages may not work in k6, because k6 is not Node.js. Check each one.',
                'Keep request names identical and compare one run in each tool at the same load before you switch.',
                'Start from a browser request with the <a href="/tools/curl-to-k6/">curl → k6 converter</a> if you\'re moving to k6.'],
        faq=[('Is Artillery free?', 'Yes. Artillery is open source under the MPL-2.0 licence. Artillery Cloud, the hosted dashboard, is a separate product with its own plans. Check its current pricing.'),
             ('Is Artillery an open or closed model tool?', 'Open by default. Phases set the arrival rate of new virtual users, and each one runs the scenario once. You can cap concurrency with maxVusers.'),
             ('Can Artillery run browser tests?', 'Yes. Artillery runs Playwright scripts as load tests. k6 has its own browser module. Either way, real browsers use far more CPU than protocol-level users, so keep browser users to a small share of the load.'),
             ('Which is faster, k6 or Artillery?', 'k6 usually needs fewer resources per request. Artillery offsets this by spreading load across AWS for you. Measure the load generator\'s CPU whichever you use.')],
        sources=['https://github.com/artilleryio/artillery (MPL-2.0)', 'https://www.artillery.io/docs (phases, ensure, expect, Playwright, Lambda and Fargate)',
                 'https://github.com/grafana/k6'],
        hub='JavaScript code on a Go engine, or YAML with Node.js hooks and built-in AWS scaling.',
    ),
    dict(
        slug='locust-vs-artillery', a='Locust', b='Artillery',
        title='Locust vs Artillery: Which Load Testing Tool Should You Use?',
        desc='Locust vs Artillery compared: Python code vs YAML with Node.js hooks, licence, open and closed load models, web UI, CI/CD and scaling.',
        ogdesc='An honest comparison of Locust and Artillery, with the same test in Python and YAML.',
        h1='Locust vs Artillery',
        lead='Two light, free tools that suit developers. Locust tests are Python classes and you can steer a run from a web UI. Artillery tests are YAML with JavaScript hooks, built around arrival rates. Your team\'s language usually decides it.',
        pick_a=['Your team writes Python, or the system has a Python client library you want to reuse.',
                'You want to change the number of users during a run from a web UI.',
                'You need to test an unusual protocol and are happy to write a small Python client.',
                'Your users behave like a fixed population (staff on an internal system), so a closed model fits.'],
        pick_b=['Your team writes JavaScript or TypeScript and uses npm.',
                'Most tests are simple flows that read well as YAML.',
                'You want arrival-rate (open) load, which matches public web traffic, as the default.',
                'You run on AWS and want the tool to spread a big test over Lambda or Fargate.'],
        rows=[
            ('How you write tests', 'Plain Python classes. Any Python library can be used.', 'YAML scenarios, with custom logic in JavaScript functions.'),
            ('Licence', 'Open source, MIT.', 'Open source, MPL-2.0.'),
            ('How load is generated', 'Each user is a gevent greenlet. One process uses one CPU core, so you run several worker processes.',
             'Node.js. Big tests can run from AWS Lambda or Fargate.'),
            ('Protocols', 'HTTP built in (HttpUser and the faster FastHttpUser). Anything else you can call from Python.',
             'HTTP, WebSocket and Socket.IO built in, Playwright browser tests, more through engines and plugins.'),
            ('Load models', 'Closed: a number of users with wait times. Custom shapes with LoadTestShape.',
             'Open: phases of new arrivals per second. Loops in the flow make longer sessions.'),
            ('CI/CD fit', 'Good. Headless mode works in CI; failing on response-time goals needs a few lines of Python.',
             'Strong. ensure checks set the exit code.'),
            ('Results and reporting', 'A live web UI with charts, plus CSV and HTML reports.',
             'A terminal summary, JSON output, Artillery Cloud dashboards and plugins that publish metrics to other tools.'),
            ('Running at scale', 'Built-in master and worker mode across machines.', 'Built-in AWS Lambda and Fargate runners, or several instances yourself.'),
            ('Learning curve', 'Very easy for Python developers.', 'Very easy for simple flows; complex logic split across YAML and JavaScript takes more care.'),
        ],
        code=[('Locust (Python)', LOCUST, LOCUST_NOTE), ('Artillery (YAML)', ARTILLERY, ARTILLERY_NOTE)],
        switch_h='Moving between Locust and Artillery',
        switch=['Translate the load model, not just the requests. Locust users are a closed population. Artillery phases are arrival rates. Use Little\'s Law: arrivals per second × seconds per visit ≈ concurrent users.',
                'A Locust <code>@task</code> maps to an Artillery scenario. Task weights map to scenario <code>weight</code>. <code>wait_time</code> maps to <code>think</code>.',
                'Python helper code becomes JavaScript processor functions.',
                'Compare one run in each tool at the same load before you switch.'],
        faq=[('Is Locust or Artillery easier?', 'Whichever matches your language. Python teams usually find Locust easier. JavaScript teams usually find Artillery easier, and simple flows in YAML need very little code at all.'),
             ('Are both free?', 'Yes. Locust is MIT and Artillery is MPL-2.0. Artillery Cloud, a hosted dashboard, is a separate product. Check its current pricing.'),
             ('Which handles more load per machine?', 'Both are interpreted, so neither is the most efficient per request. Locust needs one worker process per CPU core. Artillery can push the load out to AWS. Watch the load generator\'s CPU whichever you use.')],
        sources=['https://github.com/locustio/locust (MIT)', 'https://github.com/artilleryio/artillery (MPL-2.0)', 'https://www.artillery.io/docs'],
        hub='Python with a live web UI, or YAML with JavaScript hooks and arrival rates.',
    ),
    dict(
        slug='blazemeter-vs-grafana-cloud-k6', a='BlazeMeter', b='Grafana Cloud k6',
        title='BlazeMeter vs Grafana Cloud k6: Which Hosted Load Testing Service?',
        desc='BlazeMeter vs Grafana Cloud k6 compared: which tools each runs, where load comes from, results and analysis, CI/CD, private locations and pricing models.',
        ogdesc='An honest comparison of two hosted load testing services: BlazeMeter (JMeter and more) and Grafana Cloud k6.',
        h1='BlazeMeter vs Grafana Cloud k6',
        lead='Both run your load tests on someone else\'s load generators, so you don\'t have to build and babysit your own. The real difference is the scripts: BlazeMeter runs JMeter and other open-source tools, while Grafana Cloud k6 runs k6 scripts and puts the results next to your Grafana monitoring.',
        pick_a=['Your tests are JMeter plans (or Gatling, Locust or Selenium), and you don\'t want to rewrite them.',
                'You want API monitoring, mock services or test data generation in the same product.',
                'Testers want to upload a plan and set users, duration and locations in a web UI.',
                'You need load generators inside your own network (BlazeMeter calls them private locations).'],
        pick_b=['Your tests are k6 scripts, or you are starting fresh with a code-first team.',
                'You already use Grafana, and want load test results next to your metrics, logs and traces.',
                'You want the same script to run on a laptop, in CI and in the cloud without changes.',
                'You need load from inside your network and already run Kubernetes (private load zones use the k6 Operator).'],
        rows=[
            ('What it runs', 'JMeter, Gatling, Locust, Selenium and other open-source tools, through Taurus.', 'k6 scripts, including k6 browser tests.'),
            ('Owner', 'Perforce (bought BlazeMeter from Broadcom in 2021).', 'Grafana Labs, which also makes k6.'),
            ('How you create tests', 'Upload a .jmx or other script, write Taurus YAML, or record with the BlazeMeter browser extension.',
             'Write k6 scripts, use the test builder in the web UI, or record with Grafana k6 Studio.'),
            ('Where load comes from', 'BlazeMeter\'s cloud locations, or private locations (agents you run in your own network).',
             'Grafana\'s load zones in many cloud regions, or private load zones on your own Kubernetes.'),
            ('Results and analysis', 'Reports with run comparisons and integrations with APM tools.',
             'Results in Grafana Cloud, next to your metrics, logs and traces, with run comparisons.'),
            ('CI/CD fit', 'Taurus CLI, plugins for common CI tools, and an API.', 'The k6 CLI (k6 cloud run) from any pipeline, plus official GitHub Actions.'),
            ('Pricing model', 'Paid plans based on users and test volume, plus a limited free tier. Check the vendor\'s current pricing.',
             'Usage-based, as part of Grafana Cloud, with a limited free allowance. Check the vendor\'s current pricing.'),
            ('Lock-in', 'Low for scripts: JMeter and the other tools still run on your own machines. Reports and settings stay in BlazeMeter.',
             'Low for scripts: k6 is open source and runs anywhere. Dashboards and history stay in Grafana Cloud.'),
            ('Best fit', 'Teams with existing JMeter (or mixed-tool) suites who want hosted scale and a web UI.',
             'Developer teams on k6, especially if they already use Grafana for monitoring.'),
        ],
        code=[('BlazeMeter (Taurus YAML)', TAURUS, TAURUS_NOTE), ('Grafana Cloud k6 (JavaScript)', K6_CLOUD, K6_CLOUD_NOTE)],
        code_intro='The same simple test, set up to run in each service: load the home page, check for a 200 response, ramp up to 50 users over a minute, then hold for three minutes with one second of think time. Both fail the run if p95 goes over 500 ms.',
        switch_h='Moving between BlazeMeter and Grafana Cloud k6',
        switch=['<strong>The scripts decide the effort.</strong> Moving JMeter plans to Grafana Cloud k6 means converting them to k6: the <a href="/tools/jmeter-to-k6/">JMeter → k6 converter</a> does most of the work, and you review the result.',
                'Moving k6 scripts to BlazeMeter means rewriting them in a tool BlazeMeter runs, such as JMeter or Gatling.',
                'Match the load locations. If your users are in Australia, generate load from an Australian region in both services, or the network latency alone changes your results.',
                'Run the same test in both at the same load once and compare percentiles before you cancel anything.',
                'Check data limits and retention in each plan, so you don\'t lose the history you compare against.'],
        faq=[('Is there a free tier?', 'Both have had a limited free allowance, enough to try them. Limits change, so check each vendor\'s current pricing before you plan around it.'),
             ('Do I need a hosted service at all?', 'Not always. For a few thousand virtual users, a couple of well-sized load generators you run yourself are often enough. Hosted services earn their cost when you need many regions, very high load, shared dashboards or no infrastructure to look after.'),
             ('Can BlazeMeter run k6 scripts?', 'Check BlazeMeter\'s current list of supported tools. Its core is JMeter and the other tools Taurus supports.'),
             ('Can I test systems behind a firewall?', 'Yes, with both. BlazeMeter uses private location agents in your network. Grafana Cloud k6 uses private load zones that run on your Kubernetes cluster through the k6 Operator.')],
        sources=['https://www.blazemeter.com (product pages)', 'https://gettaurus.org/docs/ (executors, passfail, -cloud)', 'https://www.perforce.com/press-releases (BlazeMeter acquisition, 2021)',
                 'https://grafana.com/docs/grafana-cloud/testing/k6/ (load zones, private load zones, CLI)'],
        hub='Hosted load for JMeter and other tools, or for k6 with results inside Grafana.',
    ),
]

CHECKLIST = [
    ('What do you need to test?', 'HTTP APIs and websites: any of these tools works. Citrix, SAP GUI or Oracle Forms: LoadRunner or NeoLoad. JDBC, JMS or LDAP without extensions: JMeter.'),
    ('Who will write and maintain the tests?', 'Developers: pick the tool in their language (k6 or Artillery for JavaScript, Gatling for Java or Kotlin, Locust for Python). Testers who prefer a GUI: JMeter, NeoLoad or LoadRunner.'),
    ('Where will the tests run?', 'In CI on every change: k6, Gatling, Artillery or Locust are the easiest. On a schedule, from a test lab: any of them.'),
    ('What load model do you need?', 'Real users arrive whether your system is slow or not, so you usually want an arrival-rate (open) model. k6 and Gatling have both models built in, and Artillery is open by default.'),
    ('Where should the results go?', 'Already on Grafana or Prometheus: k6 fits best. Want a full report after every run with no set-up: Gatling or JMeter.'),
    ('Who runs the load generators?', 'For a few thousand users, a couple of machines you run yourself are usually enough. For many regions or very high load, a hosted service such as Grafana Cloud k6, BlazeMeter or Gatling Enterprise saves the set-up.'),
    ('What does your licence policy allow?', 'k6 is AGPL-3.0, JMeter and Gatling are Apache 2.0, Locust is MIT, Artillery is MPL-2.0, and LoadRunner and NeoLoad are commercial. If in doubt, ask your legal team.'),
    ('What do you already have?', 'A working library of tests and people who know the tool is worth a lot. Switch only for a clear reason.'),
]


def esc(t):
    return html.escape(t, quote=True)


def jsonld(objs):
    return '\n'.join('  <script type="application/ld+json">' + json.dumps(o, ensure_ascii=False) + '</script>' for o in objs)


def strip_tags(t):
    return re.sub(r'<[^>]+>', '', t)


def crumbs(items):
    """items: [(name, path or None)]; the last one is the current page."""
    parts = []
    for name, path in items:
        parts.append(f'<a href="{path}">{esc(name)}</a>' if path else f'<span aria-current="page">{esc(name)}</span>')
    return '<span aria-hidden="true">/</span>'.join(parts)


def breadcrumb_ld(items, path):
    return {'@context': 'https://schema.org', '@type': 'BreadcrumbList', 'itemListElement': [
        {'@type': 'ListItem', 'position': i + 1, 'name': name, 'item': SITE + (p or path)} for i, (name, p) in enumerate(items)]}


def fill(values):
    values = dict({'HEADEXTRA': ''}, **values)
    out = re.sub(r'\{\{([A-Z0-9]+)\}\}', lambda m: values[m.group(1)], TEMPLATE)
    assert '{{' not in out, re.findall(r'.{40}\{\{.{40}', out)
    return out


def related(current):
    """Chips under each page: comparisons that share a tool with this one (all of them on the hub), then the picker and tools."""
    cur = next((p for p in PAGES if p['slug'] == current), None)
    tools = {cur['a'], cur['b']} if cur else None
    links = [(f'/compare/{p["slug"]}/', f'{p["a"]} vs {p["b"]}') for p in PAGES
             if p['slug'] != current and (tools is None or tools & {p['a'], p['b']})]
    if current != 'tool-picker':
        links.append(('/compare/tool-picker/', 'Tool picker'))
    if current is not None:
        links.append(('/compare/', 'All comparisons'))
    links += [('/tools/jmeter-to-k6/', 'JMeter → k6 converter'), ('/guides/start/', 'Learning path'), ('/tools/', 'Free tools')]
    return '\n'.join(f'        <a href="{h}">{esc(t)} →</a>' for h, t in links)


def page(p):
    path = f'/compare/{p["slug"]}/'
    name = f'{p["a"]} vs {p["b"]}'
    items = [('Home', '/'), ('Learn', '/learn/'), ('Tool comparisons', '/compare/'), (name, None)]
    li = lambda xs: '\n'.join(f'          <li>{x}</li>' for x in xs)
    rows = '\n'.join(f'            <tr><th scope="row">{esc(r[0])}</th><td>{esc(r[1])}</td><td>{esc(r[2])}</td></tr>' for r in p['rows'])
    code = '\n'.join(
        f'''        <div>
          <h3>{esc(h)}</h3>
          <pre class="code" tabindex="0"><code>{esc(src)}</code></pre>
          <p class="note">{note}</p>
        </div>''' for h, src, note in p['code'])
    faq = '\n'.join(f'      <h3>{esc(q)}</h3>\n      <p>{esc(a)}</p>' for q, a in p['faq'])
    body = f'''    <section class="wrap cmp" id="verdict">
      <p class="eyebrow">The short answer</p>
      <h2>Which one should you pick?</h2>
      <div class="verdict">
        <div>
          <h3>Pick {esc(p["a"])} if…</h3>
          <ul>
{li(p["pick_a"])}
          </ul>
        </div>
        <div>
          <h3>Pick {esc(p["b"])} if…</h3>
          <ul>
{li(p["pick_b"])}
          </ul>
        </div>
      </div>
    </section>

    <section class="wrap cmp" id="table">
      <p class="eyebrow">Side by side</p>
      <h2>{esc(name)} at a glance</h2>
      <div class="table-wrap" tabindex="0" role="region" aria-label="{esc(name)} comparison table">
        <table class="vs">
          <thead><tr><th scope="col">&nbsp;</th><th scope="col">{esc(p["a"])}</th><th scope="col">{esc(p["b"])}</th></tr></thead>
          <tbody>
{rows}
          </tbody>
        </table>
      </div>
      <p class="scroll-hint">Swipe the table sideways to see both tools.</p>
    </section>

    <section class="wrap cmp" id="code">
      <p class="eyebrow">Same test, two tools</p>
      <h2>A 50-user load test in each</h2>
      <p>{p.get("code_intro", DEFAULT_CODE_INTRO)}</p>
      <div class="code-pair">
{code}
      </div>
    </section>

    <section class="wrap cmp" id="switch">
      <p class="eyebrow">Switching</p>
      <h2>{esc(p["switch_h"])}</h2>
      <ol>
{li(p["switch"])}
      </ol>
    </section>

    <section class="wrap cmp faq" id="faq">
      <p class="eyebrow">FAQ</p>
      <h2>Common questions</h2>
{faq}
    </section>'''
    ld = [
        {'@context': 'https://schema.org', '@type': 'Article', 'headline': p['title'], 'description': p['desc'], 'url': SITE + path,
         'author': {'@type': 'Person', 'name': 'Pawan Sinha', 'url': SITE + '/'}},
        breadcrumb_ld(items, path),
        {'@context': 'https://schema.org', '@type': 'FAQPage', 'mainEntity': [
            {'@type': 'Question', 'name': q, 'acceptedAnswer': {'@type': 'Answer', 'text': a}} for q, a in p['faq']]},
    ]
    return fill({'TITLE': esc(p['title']), 'DESC': esc(p['desc']), 'OGDESC': esc(p['ogdesc']), 'PATH': path,
                 'JSONLD': jsonld(ld), 'CRUMBS': crumbs(items), 'EYEBROW': 'Tool comparison · Load testing',
                 'H1': esc(p['h1']), 'LEAD': esc(p['lead']), 'CHECKED': CHECKED, 'BODY': body, 'RELATED': related(p['slug'])})


def hub():
    path = '/compare/'
    items = [('Home', '/'), ('Learn', '/learn/'), ('Tool comparisons', None)]
    cards = '\n'.join(
        f'''        <a class="card" href="/compare/{p["slug"]}/" data-track="compare-{p["slug"]}">
          <p class="vs-name">{esc(p["a"])} vs {esc(p["b"])}</p>
          <p>{esc(p["hub"])}</p>
          <span class="project-link">Read the comparison →</span>
        </a>''' for p in PAGES)
    checklist = '\n'.join(f'        <li><strong>{esc(q)}</strong> {esc(a)}</li>' for q, a in CHECKLIST)
    body = f'''    <section class="wrap cmp" id="picker">
      <div class="offer">
        <div>
          <p class="eyebrow">Not sure where to start?</p>
          <h3>Answer six questions, get a recommendation</h3>
          <p>The tool picker asks about your team's language, what you test, scale, budget and CI, then suggests a tool and a runner-up with the reasons.</p>
        </div>
        <div style="flex:0 1 auto"><a class="btn" href="/compare/tool-picker/" data-track="compare-hub-picker">Open the tool picker</a></div>
      </div>
    </section>

    <section class="wrap cmp" id="comparisons">
      <p class="eyebrow">Comparisons</p>
      <h2>Pick a matchup</h2>
      <div class="pick">
{cards}
      </div>
    </section>

    <section class="wrap cmp" id="choose">
      <p class="eyebrow">Checklist</p>
      <h2>How to choose a load testing tool</h2>
      <p>Answer these eight questions in order. Most teams have their answer by question three.</p>
      <ol class="checklist">
{checklist}
      </ol>
      <p>One more thing: the tool matters less than the test. A realistic workload model, clear pass/fail goals and a production-like environment are what make a load test worth running, in any tool.</p>
    </section>'''
    title = 'Load Testing Tool Comparisons: k6, JMeter, Gatling, Locust, Artillery and more'
    desc = 'Honest load testing tool comparisons: k6, JMeter, Gatling, Locust, Artillery, LoadRunner, NeoLoad and hosted services, plus a tool picker and checklist.'
    ld = [
        {'@context': 'https://schema.org', '@type': 'CollectionPage', 'name': title, 'description': desc, 'url': SITE + path,
         'hasPart': [{'@type': 'Article', 'headline': p['title'], 'url': SITE + f'/compare/{p["slug"]}/'} for p in PAGES]},
        breadcrumb_ld(items, path),
    ]
    return fill({'TITLE': esc(title), 'DESC': esc(desc), 'OGDESC': esc('k6, JMeter, Gatling, Locust, Artillery, LoadRunner, NeoLoad and hosted services compared honestly, with a tool picker.'),
                 'PATH': path, 'JSONLD': jsonld(ld), 'CRUMBS': crumbs(items), 'EYEBROW': 'Tool comparisons · Load testing',
                 'H1': 'Load testing tools compared',
                 'LEAD': 'k6, JMeter, Gatling, Locust, Artillery, LoadRunner and NeoLoad can all run a good load test. They suit different teams, protocols and budgets. Each comparison gives you a straight answer, a side-by-side table and the same test written in both tools.',
                 'CHECKED': CHECKED, 'BODY': body, 'RELATED': related(None)})


PICKER_QUESTIONS = [
    ('lang', 'Which language does the team that will write the tests use?', [
        ('js', 'JavaScript or TypeScript'), ('jvm', 'Java, Kotlin or Scala'), ('python', 'Python'),
        ('nocode', 'We\'d rather not write code (GUI and recording)'), ('other', 'Something else (.NET, Go, ...)')]),
    ('proto', 'What do you mainly need to load test?', [
        ('http', 'Websites and HTTP APIs (REST, GraphQL)'), ('browser', 'Real-browser page performance'),
        ('grpc', 'gRPC or WebSockets'), ('legacy', 'SAP GUI, Citrix, Oracle Forms or terminal apps'),
        ('backend', 'Databases, queues or directories directly (JDBC, JMS, LDAP)')]),
    ('scale', 'How much load at peak?', [
        ('small', 'Up to about 1,000 virtual users'), ('medium', '1,000 to 10,000'), ('large', 'More than 10,000, or from many regions')]),
    ('budget', 'What is the budget for tools?', [
        ('free', 'Free and open source only'), ('commercial', 'We can pay for licences or a service')]),
    ('ci', 'How often will the tests run?', [
        ('every', 'On every merge or deploy (CI)'), ('scheduled', 'Nightly or before each release'), ('none', 'By hand, when needed')]),
    ('skills', 'Which tool does your team already know?', [
        ('none', 'None yet'), ('k6', 'k6'), ('jmeter', 'JMeter'), ('gatling', 'Gatling'), ('locust', 'Locust'), ('loadrunner', 'LoadRunner')]),
]

PICKER_CSS = """  <style>
    .tp-form fieldset { border: 0; padding: 0; margin: 0 0 22px; min-width: 0; }
    .tp-form legend { font-weight: 700; color: var(--text); font-size: 17px; padding: 0; margin: 0 0 10px; }
    .tp-form legend span { color: var(--muted); font-weight: 600; margin-right: 6px; }
    .tp-opts { display: flex; flex-wrap: wrap; gap: 8px; }
    .tp-opts label { display: inline-flex; align-items: center; gap: 8px; padding: 8px 14px; border: 1px solid var(--border); border-radius: 999px;
      background: var(--surface); cursor: pointer; font-size: 15px; color: var(--text); max-width: 100%; }
    .tp-opts label:hover { border-color: var(--accent); }
    .tp-opts input { accent-color: var(--accent); margin: 0; flex: none; }
    .tp-opts label:has(input:checked) { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, var(--surface)); }
    .tp-opts input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    #tp-result { margin-top: 8px; outline: none; }
    #tp-result h2 { margin-top: 8px; }
    .tp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
    .tp-card { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 20px 22px; min-width: 0; }
    .tp-card.tp-main { border-color: var(--accent); box-shadow: var(--shadow); }
    .tp-card h3 { margin: 0 0 8px; font-size: 22px; color: var(--text); }
    .tp-card ul { margin: 0; padding-left: 20px; }
    .tp-card li { margin: 4px 0; }
    .tp-card ul.tp-links { list-style: none; padding: 0; margin-top: 12px; }
    .tp-notes ul.tp-links { list-style: none; padding: 0; margin: 6px 0; }
    .tp-links a { font-weight: 600; }
    .tp-notes { margin-top: 16px; padding: 12px 16px; border-radius: 12px; background: var(--alt); max-width: 860px; }
    .tp-notes p { margin: 6px 0; }
    .tp-compare { margin: 14px 0 0; font-weight: 600; }
    .tp-warn { color: var(--warn) !important; background: var(--warn-bg); padding: 10px 14px; border-radius: 10px; font-weight: 600; }
    .tp-notes p { max-width: 680px; }
  </style>"""


def tool_picker():
    path = '/compare/tool-picker/'
    items = [('Home', '/'), ('Learn', '/learn/'), ('Tool comparisons', '/compare/'), ('Tool picker', None)]
    fields = []
    for n, (q, legend, opts) in enumerate(PICKER_QUESTIONS, 1):
        radios = '\n'.join(f'            <label><input type="radio" name="{q}" value="{v}" required> {esc(t)}</label>' for v, t in opts)
        fields.append(f"""        <fieldset data-q="{q}">
          <legend><span>{n}.</span>{esc(legend)}</legend>
          <div class="tp-opts">
{radios}
          </div>
        </fieldset>""")
    fields = '\n'.join(fields)
    body = f"""    <section class="wrap cmp" id="questions">
      <form class="tp-form" id="tp-form" novalidate>
{fields}
        <button class="btn" type="submit" data-track="tool-picker-submit">Show my tool</button>
      </form>
      <noscript><p>The picker needs JavaScript. Without it, the <a href="/compare/#choose">checklist on the comparisons page</a> asks the same questions.</p></noscript>
      <div id="tp-result" tabindex="-1" aria-live="polite" hidden></div>
    </section>

    <section class="wrap cmp" id="how">
      <p class="eyebrow">How it decides</p>
      <h2>What the picker weighs, and what it can't know</h2>
      <p>Each answer adds or removes points for k6, JMeter, Gatling, Locust, Artillery, LoadRunner and NeoLoad. Protocols count most: if you must test SAP GUI or Citrix, only a few tools can. Then the team's language, because the people who write the tests have to maintain them. Budget, CI and scale break the ties.</p>
      <p>It can't see your security rules, your existing contracts or how much your team enjoys a GUI. Treat the answer as a shortlist, then read the comparison and run a one-day trial with your most important journey.</p>
      <p>Picked a tool? The <a href="/guides/start/">learning path</a> takes you from the first script to analysis and go-live.</p>
    </section>"""
    title = 'Load Testing Tool Picker: Which Tool Should You Use?'
    desc = 'Answer six questions about your team, protocols, scale, budget and CI, and get a recommended load testing tool and a runner-up, with the reasons.'
    ld = [{'@context': 'https://schema.org', '@type': 'WebApplication', 'name': 'Load testing tool picker', 'url': SITE + path,
           'applicationCategory': 'DeveloperApplication', 'operatingSystem': 'Any', 'offers': {'@type': 'Offer', 'price': '0', 'priceCurrency': 'AUD'},
           'description': desc}, breadcrumb_ld(items, path)]
    return fill({'TITLE': esc(title), 'DESC': esc(desc), 'OGDESC': esc(desc), 'PATH': path, 'JSONLD': jsonld(ld), 'CRUMBS': crumbs(items),
                 'EYEBROW': 'Tool picker · Load testing', 'H1': 'Which load testing tool should you use?',
                 'LEAD': esc('Six quick questions. You get a recommended tool, a runner-up and the reasons, with links to the guides and comparisons that go deeper.'),
                 'CHECKED': CHECKED, 'BODY': body + '\n    <script src="/compare/tool-picker/picker.js" defer></script>', 'RELATED': related('tool-picker'),
                 'HEADEXTRA': PICKER_CSS})


def update_sitemap(paths):
    """Replaces the compare block in docs/sitemap.xml (or the old hand-written compare lines) with every generated page."""
    sm = ROOT / 'docs' / 'sitemap.xml'
    text = sm.read_text(encoding='utf-8')
    block = '  <!-- compare:start (generated by compare/build.py) -->\n' + ''.join(
        f'  <url><loc>{SITE}{p}</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>\n' for p in paths) + '  <!-- compare:end -->'
    if '<!-- compare:start' in text:
        text = re.sub(r'  <!-- compare:start.*?<!-- compare:end -->', lambda _: block, text, flags=re.S)
    else:
        lines = text.split('\n')
        idx = [i for i, l in enumerate(lines) if f'<loc>{SITE}/compare/' in l]
        if idx:
            lines[idx[0]:idx[-1] + 1] = [block]
            text = '\n'.join(lines)
        else:
            text = text.replace('</urlset>', block + '\n</urlset>', 1)
    sm.write_text(text, encoding='utf-8')


def main():
    for p in PAGES:
        d = OUT / p['slug']
        d.mkdir(parents=True, exist_ok=True)
        (d / 'index.html').write_text(page(p))
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'index.html').write_text(hub())
    (OUT / 'tool-picker').mkdir(parents=True, exist_ok=True)
    (OUT / 'tool-picker' / 'index.html').write_text(tool_picker())  # picker.js next to it is hand-written
    update_sitemap(['/compare/', '/compare/tool-picker/'] + [f'/compare/{p["slug"]}/' for p in PAGES])
    print(f'Wrote {len(PAGES)} comparison pages, the tool picker and the hub to {OUT.relative_to(ROOT)}/')


if __name__ == '__main__':
    main()
