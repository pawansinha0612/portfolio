#!/usr/bin/env python3
"""Builds the load testing tool comparison pages from template.html.

Writes docs/compare/<slug>/index.html for every comparison in PAGES, plus the hub docs/compare/index.html.
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
]

CHECKLIST = [
    ('What do you need to test?', 'HTTP APIs and websites: any of these tools works. Citrix, SAP GUI or terminal apps: LoadRunner. JDBC, JMS or LDAP without extensions: JMeter.'),
    ('Who will write and maintain the tests?', 'Developers: pick the tool in their language (k6 for JavaScript, Gatling for Java or Kotlin, Locust for Python). Testers who prefer a GUI: JMeter or LoadRunner.'),
    ('Where will the tests run?', 'In CI on every change: k6, Gatling or Locust are the easiest. On a schedule, from a test lab: any of them.'),
    ('What load model do you need?', 'Real users arrive whether your system is slow or not, so you usually want an arrival-rate (open) model. k6 and Gatling have one built in.'),
    ('Where should the results go?', 'Already on Grafana or Prometheus: k6 fits best. Want a full report after every run with no set-up: Gatling or JMeter.'),
    ('What does your licence policy allow?', 'k6 is AGPL-3.0; JMeter and Gatling are Apache 2.0; Locust is MIT; LoadRunner is commercial. If in doubt, ask your legal team.'),
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
    out = re.sub(r'\{\{([A-Z0-9]+)\}\}', lambda m: values[m.group(1)], TEMPLATE)
    assert '{{' not in out, re.findall(r'.{40}\{\{.{40}', out)
    return out


def related(current):
    links = [(f'/compare/{p["slug"]}/', f'{p["a"]} vs {p["b"]}') for p in PAGES if p['slug'] != current]
    links += [('/compare/', 'All comparisons'), ('/tools/jmeter-to-k6/', 'JMeter → k6 converter'), ('/tools/curl-to-k6/', 'curl → k6 converter'), ('/tools/', 'Free tools')]
    if current is None:
        links = [l for l in links if l[0] != '/compare/']
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
      <p>The same simple test in both: load the home page, check for a 200 response, ramp up to 50 users over a minute, then hold for three minutes with one second of think time.</p>
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
    body = f'''    <section class="wrap cmp" id="comparisons">
      <p class="eyebrow">Comparisons</p>
      <h2>Pick a matchup</h2>
      <div class="pick">
{cards}
      </div>
    </section>

    <section class="wrap cmp" id="choose">
      <p class="eyebrow">Checklist</p>
      <h2>How to choose a load testing tool</h2>
      <p>Answer these seven questions in order. Most teams have their answer by question three.</p>
      <ol class="checklist">
{checklist}
      </ol>
      <p>One more thing: the tool matters less than the test. A realistic workload model, clear pass/fail goals and a production-like environment are what make a load test worth running, in any tool.</p>
    </section>'''
    title = 'Load Testing Tool Comparisons: k6, JMeter, Gatling, Locust, LoadRunner'
    desc = 'Honest comparisons of load testing tools: k6 vs JMeter, k6 vs Gatling, k6 vs Locust and JMeter vs LoadRunner, plus a checklist for choosing the right one.'
    ld = [
        {'@context': 'https://schema.org', '@type': 'CollectionPage', 'name': title, 'description': desc, 'url': SITE + path,
         'hasPart': [{'@type': 'Article', 'headline': p['title'], 'url': SITE + f'/compare/{p["slug"]}/'} for p in PAGES]},
        breadcrumb_ld(items, path),
    ]
    return fill({'TITLE': esc(title), 'DESC': esc(desc), 'OGDESC': esc('k6, JMeter, Gatling, Locust and LoadRunner compared honestly, with a checklist for choosing.'),
                 'PATH': path, 'JSONLD': jsonld(ld), 'CRUMBS': crumbs(items), 'EYEBROW': 'Tool comparisons · Load testing',
                 'H1': 'Load testing tools compared',
                 'LEAD': 'k6, JMeter, Gatling, Locust and LoadRunner can all run a good load test. They suit different teams, protocols and budgets. Each comparison gives you a straight answer, a side-by-side table and the same test written in both tools.',
                 'CHECKED': CHECKED, 'BODY': body, 'RELATED': related(None)})


def main():
    for p in PAGES:
        d = OUT / p['slug']
        d.mkdir(parents=True, exist_ok=True)
        (d / 'index.html').write_text(page(p))
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'index.html').write_text(hub())
    print(f'Wrote {len(PAGES)} comparison pages and the hub to {OUT.relative_to(ROOT)}/')


if __name__ == '__main__':
    main()
