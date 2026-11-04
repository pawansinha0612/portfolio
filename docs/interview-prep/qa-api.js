// API testing interview questions and model answers, used by /interview-prep/api-testing/ and /interview-prep/practice/.
// Each item: q = question, t = topics (used by the filters), a = model answer (HTML).
(window.QA_TRACKS = window.QA_TRACKS || {}).api = {
  basic: [
    { q: 'What is an API, and what makes an API RESTful?', t: ['HTTP & REST'], a: `
      <p>An API is a contract that lets one piece of software ask another for data or actions. A web API usually does this over HTTP, with JSON in the request and response.</p>
      <p>REST is an architectural style, not a standard. A RESTful API usually follows these ideas:</p>
      <ul>
        <li><strong>Resources</strong> identified by URLs, such as <code>/customers/42/orders</code>. Nouns, not verbs.</li>
        <li><strong>Standard HTTP methods</strong> for actions: GET reads, POST creates, PUT replaces, PATCH updates part, DELETE removes.</li>
        <li><strong>Stateless</strong> requests. Each request carries everything the server needs, including auth. The server doesn't remember the previous call.</li>
        <li><strong>Meaningful status codes</strong> and headers, so clients can react without parsing the body.</li>
        <li><strong>Cacheable</strong> responses where it makes sense.</li>
      </ul>
      <p>For a tester, this matters because REST gives you expectations to test against. If <code>GET</code> changes data, or every error comes back as 200, that's a defect in the design, not just the code.</p>` },
    { q: 'Explain GET, POST, PUT, PATCH and DELETE. Which ones are idempotent?', t: ['HTTP & REST'], a: `
      <ul>
        <li><strong>GET:</strong> read a resource. Safe (no side effects) and idempotent.</li>
        <li><strong>POST:</strong> create a resource or trigger an action. Not idempotent. Send it twice and you may get two orders.</li>
        <li><strong>PUT:</strong> replace the whole resource with what you send. Idempotent. Sending the same PUT ten times leaves the same end state.</li>
        <li><strong>PATCH:</strong> partial update. <strong>Not guaranteed to be idempotent.</strong> Setting <code>{"status":"paid"}</code> is idempotent in practice, but an operation like "add 1 to quantity" is not.</li>
        <li><strong>DELETE:</strong> remove a resource. Idempotent in terms of server state, even though the second call may return 404 instead of 204.</li>
      </ul>
      <p>Idempotent means repeating the request has the same effect on the server as sending it once. It's about state, not identical responses.</p>
      <div class="say">I test idempotency directly: send the same PUT or DELETE twice and check the data, not just the status code. For POST, I check what happens when a client retries after a timeout.</div>` },
    { q: 'Which HTTP status codes should every API tester know? What is the difference between 401 and 403?', t: ['HTTP & REST', 'Auth'], a: `
      <ul>
        <li><strong>2xx success:</strong> 200 OK, 201 Created (often with a <code>Location</code> header), 204 No Content.</li>
        <li><strong>4xx client error:</strong> 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 405 Method Not Allowed, 409 Conflict, 415 Unsupported Media Type, 422 Unprocessable Content, 429 Too Many Requests.</li>
        <li><strong>5xx server error:</strong> 500 Internal Server Error, 502 Bad Gateway, 503 Service Unavailable, 504 Gateway Timeout.</li>
      </ul>
      <p><strong>401</strong> means "I don't know who you are". The credentials are missing, expired or invalid. Despite the name, it's about authentication. <strong>403</strong> means "I know who you are, but you're not allowed to do this". That's authorisation.</p>
      <p>Some APIs return 404 instead of 403 for another user's resource, so they don't reveal that it exists. That's a valid design choice, as long as it's consistent.</p>
      <div class="say">A 5xx caused by bad input is always a bug. The client did something wrong, so the server should say so with a 4xx.</div>` },
    { q: 'What is the difference between path parameters, query parameters, headers and the request body?', t: ['HTTP & REST'], a: `
      <ul>
        <li><strong>Path parameters</strong> identify a specific resource: <code>/orders/1234</code>. If it's missing, you're asking for a different resource.</li>
        <li><strong>Query parameters</strong> modify a request, usually a read: filtering, sorting, paging. <code>/orders?status=open&amp;page=2</code>. They are optional by nature.</li>
        <li><strong>Headers</strong> carry metadata about the request: <code>Authorization</code>, <code>Content-Type</code>, <code>Accept</code>, correlation IDs, cache controls.</li>
        <li><strong>Body</strong> carries the data you're sending, usually JSON on POST, PUT and PATCH.</li>
      </ul>
      <p>Each one needs its own tests. For a path parameter: valid ID, unknown ID, wrong type (<code>/orders/abc</code>), another user's ID. For query parameters: missing, unknown, empty, invalid values and combinations. For headers: missing or wrong <code>Content-Type</code>, missing auth. Never put secrets in query strings, because they end up in logs and browser history.</p>` },
    { q: 'How would you test a simple GET /users/{id} endpoint?', t: ['Test design'], a: `
      <p>I group the tests so nothing obvious gets missed.</p>
      <ol>
        <li><strong>Happy path:</strong> a valid ID returns 200, the right user, and a body that matches the schema.</li>
        <li><strong>Not found:</strong> a valid-format ID that doesn't exist returns 404 with a clear error body.</li>
        <li><strong>Invalid input:</strong> letters, negative numbers, very long values, special characters. Expect 400, never a 500.</li>
        <li><strong>Auth:</strong> no token gives 401. A valid token for a different user gives 403 or 404, not that user's data.</li>
        <li><strong>Data exposure:</strong> the response doesn't leak fields like password hashes or internal flags.</li>
        <li><strong>Headers:</strong> correct <code>Content-Type</code>, sensible caching headers.</li>
        <li><strong>Method checks:</strong> unsupported methods return 405.</li>
        <li><strong>Response time:</strong> a quick check that it's within the agreed limit.</li>
      </ol>
      <div class="say">The test I never skip on an ID endpoint is "can user A read user B's record". It's simple to run and it's one of the most common serious API bugs.</div>` },
    { q: 'Beyond the status code, what should you assert in an API test?', t: ['Test design', 'Data'], a: `
      <p>A 200 only tells you the server didn't fail. It doesn't tell you the answer is right. I check:</p>
      <ul>
        <li><strong>Body values:</strong> the specific fields that matter for this test, such as the ID, totals and status.</li>
        <li><strong>Schema:</strong> required fields present, correct types, no unexpected nulls.</li>
        <li><strong>Headers:</strong> <code>Content-Type</code>, <code>Location</code> on a 201, rate limit or cache headers if relevant.</li>
        <li><strong>Side effects:</strong> after a POST, a follow-up GET returns the new record. After a DELETE, it's really gone. Where possible, check the database or downstream event too.</li>
        <li><strong>Error bodies:</strong> on a 4xx, a useful message and error code, with no stack trace.</li>
        <li><strong>Response time:</strong> a loose upper bound, to catch big regressions.</li>
      </ul>
      <p>Don't assert on everything, though. Asserting on timestamps or generated IDs makes tests brittle. Assert on what the test is actually about, and let schema validation cover the shape.</p>` },
    { q: 'How do you use Postman collections, environments and variables?', t: ['Postman'], a: `
      <p>A <strong>collection</strong> is a group of saved requests, organised into folders, usually one per API or feature. Each request can have scripts that run before it and tests that run after it.</p>
      <p>An <strong>environment</strong> is a set of variables for one target, such as dev, test or staging. The same collection runs against any of them by switching environment.</p>
      <p><strong>Variables</strong> are written as <code>{{baseUrl}}</code>. Postman has several scopes. From broadest to narrowest: global, collection, environment, data (from a CSV or JSON data file) and local. The narrowest scope wins if the same name exists in more than one.</p>
      <pre>// Tests tab: save a value for the next request
const body = pm.response.json();
pm.environment.set('orderId', body.id);</pre>
      <p>Good habits: no hard-coded URLs or tokens in requests, secrets kept out of exported files, and the collection stored in version control so it's reviewed like code.</p>` },
    { q: 'What are the differences between API keys, Basic auth and bearer tokens?', t: ['Auth', 'Security'], a: `
      <ul>
        <li><strong>API key:</strong> a long random string, sent in a header such as <code>x-api-key</code>. It identifies the calling application, not a user. Simple, but often long-lived, so a leaked key is a real risk.</li>
        <li><strong>Basic auth:</strong> <code>Authorization: Basic</code> followed by base64 of <code>username:password</code>. Base64 is encoding, not encryption, so it is only acceptable over HTTPS.</li>
        <li><strong>Bearer token:</strong> <code>Authorization: Bearer &lt;token&gt;</code>. Whoever holds the token can use it. Usually short-lived and issued by an OAuth 2.0 server, often as a JWT.</li>
      </ul>
      <p>For any of them I test: missing credentials, wrong credentials, expired or revoked credentials, credentials for the wrong environment, and that the API rejects plain HTTP. I also check credentials never appear in URLs, logs or error messages.</p>
      <div class="say">Base64 is not security. Anyone who sees a Basic auth header can decode the password in a second, which is why HTTPS is not optional.</div>` },
    { q: 'What is JSON Schema validation, and why is it useful in API tests?', t: ['Contract', 'Data'], a: `
      <p>A JSON Schema describes the expected shape of a JSON document: which fields are required, their types, formats, allowed values and ranges. A test validates the response against it.</p>
      <pre>{
  "type": "object",
  "required": ["id", "email", "status"],
  "properties": {
    "id": { "type": "integer" },
    "email": { "type": "string", "format": "email" },
    "status": { "enum": ["active", "suspended"] }
  }
}</pre>
      <p>Why it helps:</p>
      <ul>
        <li>One assertion checks the whole structure, so you don't write twenty field-by-field checks.</li>
        <li>It catches silent breaking changes: a renamed field, a number turned into a string, a field that is suddenly null.</li>
        <li>If the API has an OpenAPI spec, the schemas already exist, so tests and docs stay in sync.</li>
      </ul>
      <p>Schema validation proves the shape, not the values. You still need assertions on the data that matters for the test.</p>` },
    { q: 'Why test at the API layer instead of only through the UI?', t: ['Test design', 'Automation'], a: `
      <p>Most business logic lives behind the API, and the API layer is where tests give the best return.</p>
      <ul>
        <li><strong>Faster:</strong> an API test runs in milliseconds. A UI test of the same rule can take a minute.</li>
        <li><strong>More stable:</strong> no locators, rendering or animation timing to break the test.</li>
        <li><strong>Better coverage:</strong> you can send inputs the UI would never allow, such as negative quantities or missing fields. Attackers don't use your UI either.</li>
        <li><strong>Earlier:</strong> you can test the API before the UI is built.</li>
        <li><strong>Clearer failures:</strong> a failing API test points to one service and one request.</li>
      </ul>
      <p>UI tests still matter for real user journeys and integration of the front end. But they should be a thin layer on top, with the rules and edge cases covered at the API level.</p>
      <div class="say">I push each test down to the lowest layer that can catch the bug. For business rules, that's usually the API, not the browser.</div>` },
  ],
  intermediate: [
    { q: 'How would you design positive, negative and boundary tests for a POST /orders endpoint?', t: ['Test design', 'Data'], a: `
      <p>I start from the spec or acceptance criteria and list the rules for each field, then design tests per group.</p>
      <ul>
        <li><strong>Positive:</strong> a valid order with required fields only, then with all optional fields. Expect 201, a <code>Location</code> header, the created order in the body, and the record retrievable with GET.</li>
        <li><strong>Negative:</strong> missing required fields, wrong types (<code>"quantity": "two"</code>), invalid enums, malformed JSON, wrong <code>Content-Type</code>, unknown product, unauthenticated request. Expect clear 4xx errors, never 500.</li>
        <li><strong>Boundary:</strong> quantity 0, 1, max, max+1. Empty strings, maximum string lengths, decimal precision on prices, very large payloads.</li>
        <li><strong>Business rules:</strong> out-of-stock items, a customer over a credit limit, duplicate submission.</li>
        <li><strong>Security:</strong> extra fields such as <code>"price": 0.01</code> or <code>"status": "paid"</code> must be ignored or rejected, not saved.</li>
      </ul>
      <p>I use equivalence partitioning to keep the list short, and data-driven tests so one test method covers many input rows.</p>
      <div class="say">The test that often finds a real bug is sending a field the client shouldn't control, like price. If the server trusts it, that's mass assignment.</div>` },
    { q: 'When should an API return 400, 422 or 409? And what do 429 and the 5xx codes tell you?', t: ['HTTP & REST', 'Test design'], a: `
      <ul>
        <li><strong>400 Bad Request:</strong> the request can't be understood. Malformed JSON, wrong types, a missing required header.</li>
        <li><strong>422 Unprocessable Content</strong> (often still called Unprocessable Entity): the request is well-formed but fails validation. For example, an end date before the start date. Some teams use 400 for both. Either is fine if it's documented and consistent.</li>
        <li><strong>409 Conflict:</strong> the request clashes with the current state. A duplicate username, or an update based on an old version of the record.</li>
        <li><strong>429 Too Many Requests:</strong> the client hit a rate limit. It may include a <code>Retry-After</code> header.</li>
        <li><strong>500:</strong> an unhandled error on the server. <strong>502/504:</strong> a gateway or proxy got a bad response or no response from upstream. <strong>503:</strong> the service is overloaded or down for maintenance.</li>
      </ul>
      <p>As a tester I check that the code matches the documented contract, and that the error body is useful. Clients make retry decisions from these codes. Retrying a 503 can make sense. Retrying a 400 never will.</p>` },
    { q: 'How do you use pre-request scripts and tests in Postman, and run a collection in CI?', t: ['Postman', 'Automation'], a: `
      <p><strong>Pre-request scripts</strong> run before a request. I use them to get a token, generate unique test data or compute a signature. <strong>Tests</strong> (post-response scripts) run after it and hold the assertions.</p>
      <pre>// Post-response script
pm.test('order created', () =&gt; {
  pm.response.to.have.status(201);
  const body = pm.response.json();
  pm.expect(body.status).to.eql('pending');
  pm.collectionVariables.set('orderId', body.id);
});</pre>
      <p>To run in CI, export the collection and environment (or pull them through the Postman API) and use Newman, the command-line runner:</p>
      <pre>newman run orders.postman_collection.json \\
  -e test.postman_environment.json \\
  --reporters cli,junit --reporter-junit-export results.xml</pre>
      <p>The pipeline fails if any test fails, and the JUnit report shows the results. Secrets come from the CI secret store as environment variables, never from a committed file. Postman also has its own CLI, which does a similar job.</p>
      <div class="say">If a Postman collection only runs on someone's laptop, it's documentation, not automation. Newman in the pipeline is what makes it a regression suite.</div>` },
    { q: 'Explain OAuth 2.0 client credentials and authorisation code with PKCE. How would you test them?', t: ['Auth', 'Security'], a: `
      <p><strong>Client credentials</strong> is for machine-to-machine calls with no user. The service sends its client ID and secret to the token endpoint and gets an access token back. It's typical for backend integrations and batch jobs.</p>
      <p><strong>Authorisation code with PKCE</strong> is for a user signing in through an app. The app redirects the user to the authorisation server, the user logs in and consents, and the app receives a short-lived code. It swaps the code for tokens. PKCE adds a random <code>code_verifier</code>. The app sends a hash of it (the <code>code_challenge</code>) at the start and the original verifier when swapping the code. A stolen code is useless without the verifier.</p>
      <p>What I test:</p>
      <ul>
        <li>Wrong secret, wrong verifier or a reused code is rejected.</li>
        <li>Scopes are enforced: a read-only token can't write.</li>
        <li>Expired and revoked tokens get 401.</li>
        <li>Redirect URIs must match exactly what's registered.</li>
        <li>Tokens for one client or environment don't work in another.</li>
      </ul>
      <p>In automation, I usually get tokens with client credentials or a test-only flow, rather than scripting the login UI.</p>` },
    { q: 'What is a JWT, and what would you test about one?', t: ['Auth', 'Security'], a: `
      <p>A JSON Web Token has three base64url-encoded parts separated by dots: <code>header.payload.signature</code>. The header names the algorithm. The payload holds claims such as <code>sub</code>, <code>exp</code>, <code>iss</code>, <code>aud</code> and roles. The signature proves the token hasn't been changed.</p>
      <p>A standard JWT is <strong>signed, not encrypted</strong>. Anyone can decode the payload, so it must not carry secrets or personal data the client shouldn't see. (Encrypted JWTs, called JWE, exist but are less common.)</p>
      <p>What I test:</p>
      <ul>
        <li>Change a claim, such as the role or user ID, without re-signing. It must be rejected.</li>
        <li>Expired token (<code>exp</code> in the past) gets 401.</li>
        <li>Wrong <code>iss</code> or <code>aud</code>, for example a token from another environment, is rejected.</li>
        <li><code>"alg": "none"</code> with the signature removed is rejected.</li>
        <li>Algorithm confusion, such as switching RS256 to HS256, is rejected.</li>
        <li>A token signed with a different key is rejected.</li>
      </ul>
      <div class="say">I paste the token into a decoder and read the claims. If I can see something sensitive, so can anyone who intercepts it.</div>` },
    { q: 'How do you test pagination, filtering and sorting on a list endpoint?', t: ['HTTP & REST', 'Data', 'Test design'], a: `
      <p>I set up known test data first, so I can predict every result. Testing lists against random shared data proves very little.</p>
      <p><strong>Pagination:</strong></p>
      <ul>
        <li>First, middle and last page. A page past the end returns an empty list, not an error.</li>
        <li>Page size at default, 1, maximum and maximum+1. Is the cap enforced?</li>
        <li>Invalid values: 0, negative, text.</li>
        <li>No duplicates or gaps across pages, including when records are added between calls. Cursor-based paging handles this better than offset paging.</li>
        <li>Totals and next/previous links are correct.</li>
      </ul>
      <p><strong>Filtering:</strong> each filter alone, filters combined, a filter matching nothing, unknown filter names, and injection-style values.</p>
      <p><strong>Sorting:</strong> ascending and descending, ties (is the order stable?), nulls, case sensitivity, and an unknown sort field.</p>
      <p>And always: a user only sees their own records, whatever filter they send.</p>` },
    { q: 'How would you test rate limiting on an API?', t: ['HTTP & REST', 'Security'], a: `
      <p>First I find out the rule: how many requests, over what window, and per what key (API key, user, IP or token). Then I test that rule.</p>
      <ol>
        <li>Send requests up to the limit. All succeed.</li>
        <li>Send one more. Expect 429, ideally with a <code>Retry-After</code> header and a clear error body.</li>
        <li>Check rate limit headers, if the API uses them, count down correctly.</li>
        <li>Wait for the window to reset. Requests succeed again.</li>
        <li>Check isolation: client A hitting the limit doesn't block client B.</li>
        <li>Try to bypass it: rotating headers such as <code>X-Forwarded-For</code>, changing case in the URL, or spreading calls across endpoints that share a backend.</li>
      </ol>
      <p>Sensitive endpoints such as login, password reset and OTP checks need tighter limits, because they're targets for brute force.</p>
      <p>Use a small tool or script, not a full load test. The rule may apply across several gateway nodes, so check it holds when requests hit different instances.</p>` },
    { q: 'What is mocking or service virtualisation, and when would you use it?', t: ['Microservices', 'Automation'], a: `
      <p>A mock or virtual service stands in for a real dependency and returns controlled responses. Tools include WireMock, Mockoon, Prism (driven from an OpenAPI spec) and Postman mock servers.</p>
      <p>I use it when the real dependency is:</p>
      <ul>
        <li><strong>Not built yet</strong>, so the team can test against the agreed contract.</li>
        <li><strong>Unreliable or shared</strong>, causing flaky tests that fail for reasons unrelated to the change.</li>
        <li><strong>Expensive or risky</strong>, such as a payment provider or a third party that charges per call.</li>
        <li><strong>Hard to make misbehave.</strong> A mock can return a 503, a timeout, a slow response or malformed JSON on demand. That's the best way to test error handling and retries.</li>
      </ul>
      <p>The risk is that a mock drifts from reality and your tests pass against something that no longer exists. I keep mocks tied to the contract, ideally verified with contract tests, and still run a smaller set of tests against the real integration.</p>
      <div class="say">Mocks let me test the failure paths that are almost impossible to trigger with real services, like a timeout halfway through a payment.</div>` },
    { q: 'How is testing a GraphQL API different from testing a REST API?', t: ['GraphQL', 'Test design'], a: `
      <p>GraphQL usually has one endpoint, often <code>POST /graphql</code>. The client sends a query that says exactly which fields it wants. That changes a few things:</p>
      <ul>
        <li><strong>Status codes say less.</strong> Many GraphQL servers return 200 even when the query fails, with an <code>errors</code> array in the body. A response can also have partial <code>data</code> and some errors. Always assert on <code>errors</code>, not just the status.</li>
        <li><strong>The schema is the contract.</strong> It's strongly typed, so schema changes, like removed fields or a field becoming non-null, are the main source of breaking changes.</li>
        <li><strong>Auth is per field and per object,</strong> not per URL. Test that a user can't reach restricted fields through nested queries.</li>
        <li><strong>Queries can be expensive.</strong> Deep nesting, large lists and aliases can overload the server. Check depth and complexity limits.</li>
        <li><strong>Mutations</strong> need the same positive, negative and boundary tests as REST POST and PUT calls.</li>
      </ul>
      <pre>query { order(id: "123") { id status customer { email } } }</pre>
      <p>I also check whether introspection is enabled in production, and that error messages don't leak internals.</p>` },
    { q: 'How can you use an OpenAPI specification to drive API testing?', t: ['Contract', 'Automation'], a: `
      <p>An OpenAPI (formerly Swagger) spec describes every endpoint, parameter, request body, response code and schema. It's useful well beyond documentation.</p>
      <ul>
        <li><strong>Review it early.</strong> I test the spec itself before code exists: missing error responses, inconsistent naming, no limits on string lengths or page sizes.</li>
        <li><strong>Response validation.</strong> Tests check every response against the schema in the spec, so docs and implementation can't drift apart silently.</li>
        <li><strong>Generated tests.</strong> Tools such as Schemathesis or Dredd read the spec and generate requests, including odd and boundary inputs. They're good at finding 500s.</li>
        <li><strong>Mock servers.</strong> Tools like Prism serve example responses from the spec, so consumers can start before the API is ready.</li>
        <li><strong>Breaking change checks.</strong> Diffing the spec between versions in CI flags removed fields or new required parameters.</li>
        <li><strong>Client generation.</strong> Typed clients for your test framework, so a contract change breaks the build.</li>
      </ul>
      <p>The catch: the spec is only useful if it's accurate. Validating responses against it in CI is what keeps it honest.</p>` },
  ],
  advanced: [
    { q: 'What is consumer-driven contract testing, and how does Pact work?', t: ['Contract', 'Microservices'], a: `
      <p>In consumer-driven contract testing, each consumer of an API states what it actually needs: the requests it sends and the parts of the response it relies on. The provider then proves it meets every consumer's expectations.</p>
      <p>With Pact, the flow is:</p>
      <ol>
        <li>The consumer team writes unit-level tests against a Pact mock provider. The tests define the expected interactions.</li>
        <li>Running them produces a <strong>pact file</strong>: a JSON contract of those interactions.</li>
        <li>The pact is published to a Pact Broker (or PactFlow).</li>
        <li>The provider's pipeline pulls the pacts and replays each request against the real provider, checking the responses match. Provider states set up the data each interaction needs.</li>
        <li>Before deploying, a <code>can-i-deploy</code> check asks the broker whether this version is compatible with what's in the target environment.</li>
      </ol>
      <p>The benefit: breaking changes are caught in the provider's own build, in minutes, without a shared end-to-end environment. It doesn't replace functional testing of the provider. It only checks what consumers use.</p>
      <div class="say">Contract tests answer one question well: if I deploy this service now, will I break anyone who calls it?</div>` },
    { q: 'How would you design an API test automation framework from scratch?', t: ['Automation'], a: `
      <p>I pick the tool to suit the team's language. REST Assured for Java teams, Playwright's request API or a plain HTTP client for TypeScript teams. The structure matters more than the tool.</p>
      <ul>
        <li><strong>Layers:</strong> tests call a thin client layer (one class per service), which calls the HTTP library. Tests read like business steps, not raw HTTP.</li>
        <li><strong>Config:</strong> base URLs and credentials per environment from config and secrets, never hard-coded.</li>
        <li><strong>Auth helper:</strong> gets and caches tokens, and refreshes them when they expire.</li>
        <li><strong>Test data:</strong> builders or factories that create unique data per test, through the API, and clean up after.</li>
        <li><strong>Assertions:</strong> schema validation plus focused value checks.</li>
        <li><strong>Reporting:</strong> request and response logged on failure, with a correlation ID to find server logs.</li>
        <li><strong>CI:</strong> runs on every pull request, in parallel, with tags for smoke and full regression.</li>
      </ul>
      <pre>given().spec(authSpec).body(order)
.when().post("/orders")
.then().statusCode(201).body("status", equalTo("pending"));</pre>
      <div class="say">Every test should be able to run alone, in any order, in parallel. If it can't, the framework has a test data problem.</div>` },
    { q: 'How do you test asynchronous, event-driven APIs such as queues and webhooks?', t: ['Microservices', 'Automation'], a: `
      <p>With async APIs, the first response often just says "accepted" (a 202). The real work happens later, somewhere else. So the tests have to follow the work.</p>
      <ul>
        <li><strong>Poll, don't sleep.</strong> After the trigger, poll the status endpoint, database or topic until the expected state appears, with a sensible timeout. A fixed sleep is either too short (flaky) or too long (slow).</li>
        <li><strong>Check the message itself:</strong> schema, key fields and headers, by consuming from a test subscription.</li>
        <li><strong>Duplicates:</strong> most brokers deliver at least once. Send the same message twice and check the consumer is idempotent.</li>
        <li><strong>Ordering:</strong> what happens if "order cancelled" arrives before "order created"?</li>
        <li><strong>Failures:</strong> a poison message goes to a dead-letter queue after retries. It doesn't block the queue forever.</li>
      </ul>
      <p>For <strong>webhooks</strong>, I stand up a test receiver and check the payload, the signature (usually an HMAC the receiver must verify), retries when the receiver returns 500 or times out, and rejection of unsigned or replayed calls.</p>
      <div class="say">Eventual consistency means "consistent within some time". I get that time agreed as a number, then test against it.</div>` },
    { q: 'How do you test an API against the OWASP API Security Top 10, especially BOLA?', t: ['Security', 'Auth'], a: `
      <p>The OWASP API Security Top 10 lists the most common API risks. Broken Object Level Authorisation (<strong>BOLA</strong>) is at the top. It means the API checks that you're logged in but not that the object you asked for is yours.</p>
      <p>To test BOLA, I use two test users. User A creates a resource. User B then tries to GET, PUT, PATCH and DELETE it using its ID. Every attempt should fail. I repeat this for nested resources (<code>/accounts/{id}/statements</code>), IDs in the body or query string, and bulk endpoints.</p>
      <p>Other items I test routinely:</p>
      <ul>
        <li><strong>Broken authentication:</strong> weak token checks, no brute-force protection on login.</li>
        <li><strong>Object property level authorisation:</strong> responses exposing too many fields, and mass assignment of fields like <code>role</code>.</li>
        <li><strong>Function level authorisation:</strong> a normal user calling admin endpoints.</li>
        <li><strong>Unrestricted resource consumption:</strong> no rate limits, no page size caps, huge uploads.</li>
        <li><strong>SSRF:</strong> any field that takes a URL the server will fetch.</li>
        <li><strong>Inventory:</strong> old API versions or debug endpoints still live.</li>
      </ul>
      <div class="say">Sequential or guessable IDs make BOLA easy to exploit, but random IDs don't fix it. Only a server-side ownership check does.</div>` },
    { q: 'How do idempotency keys work for payment APIs, and how would you test them?', t: ['HTTP & REST', 'Test design'], a: `
      <p>A payment is usually a POST, which isn't idempotent. If the client times out and retries, the customer could be charged twice. An idempotency key fixes this. The client generates a unique key per operation, often sent in an <code>Idempotency-Key</code> header. The server stores the key with the result. A retry with the same key returns the stored result instead of charging again.</p>
      <p>What I test:</p>
      <ul>
        <li>Same key, same body: one charge, and the second response matches the first.</li>
        <li>Same key, different body: rejected with a clear error, not silently processed.</li>
        <li>Different keys, same body: two charges. That is correct behaviour.</li>
        <li><strong>Concurrency:</strong> two requests with the same key at the same moment. Only one charge. This is where race conditions hide.</li>
        <li>A retry while the first request is still in progress.</li>
        <li>A retry after the first attempt failed with a 500 or timed out downstream.</li>
        <li>Key expiry: what happens after the documented retention period.</li>
        <li>Missing key: rejected, or handled as documented.</li>
      </ul>
      <div class="say">The concurrent duplicate is the test that matters most. Sequential retries are easy to get right. Two identical requests arriving together are not.</div>` },
    { q: 'How do you handle API versioning and catch breaking changes before they reach consumers?', t: ['Contract', 'HTTP & REST'], a: `
      <p>Common versioning styles are a version in the path (<code>/v2/orders</code>), in a header, or in the media type. The style matters less than having a clear rule for what counts as breaking.</p>
      <p><strong>Usually breaking:</strong> removing or renaming a field, changing a type, making an optional field required, adding a new required request field, changing status codes or error formats, tightening validation.</p>
      <p><strong>Usually safe:</strong> adding an optional field or a new endpoint. But only if clients ignore unknown fields. Adding a new enum value can break clients that use strict parsing.</p>
      <p>How I catch it:</p>
      <ul>
        <li>Diff the OpenAPI spec between versions in CI and fail on breaking changes.</li>
        <li>Consumer-driven contract tests, so the provider's build knows what each consumer relies on.</li>
        <li>Keep the previous version's regression suite running while it's still supported.</li>
        <li>Check deprecation is communicated, for example with a <code>Deprecation</code> or <code>Sunset</code> header and a published timeline.</li>
      </ul>
      <div class="say">A change is breaking if any real consumer breaks, whatever the spec says. That's why I want to know who the consumers are and what they use.</div>` },
    { q: 'What test strategy and test data approach would you use for a microservices system?', t: ['Microservices', 'Data'], a: `
      <p>I aim for most confidence from fast, isolated tests, and keep slow end-to-end tests few.</p>
      <ol>
        <li><strong>Unit and component tests</strong> per service, with dependencies mocked. Owned by the service team.</li>
        <li><strong>Contract tests</strong> between each consumer and provider, to catch breaking changes without a shared environment.</li>
        <li><strong>Integration tests</strong> for each service with its real database, queue and cache, often in containers.</li>
        <li><strong>A small set of end-to-end journeys</strong> across services for the flows that make money or carry risk.</li>
        <li><strong>Resilience checks:</strong> a dependency is slow or down. Do timeouts, retries and circuit breakers behave?</li>
      </ol>
      <p><strong>Test data</strong> is often the hardest part, because one customer's data is spread across many services.</p>
      <ul>
        <li>Create data through the public APIs, so every service's view is consistent.</li>
        <li>Make data unique per test run, so parallel runs don't collide.</li>
        <li>Never copy raw production data. Use synthetic or properly masked data.</li>
        <li>Clean up, or use short-lived environments.</li>
      </ul>
      <div class="say">If every change needs a full end-to-end run in one shared environment to be trusted, the services aren't really independent.</div>` },
    { q: 'Your API test suite is flaky. How do you find and fix the causes?', t: ['Automation', 'Data'], a: `
      <p>First, I measure it. I track which tests fail without a code change and how often. Rerunning until green hides the problem and teaches people to ignore red builds.</p>
      <p>Common causes, and fixes:</p>
      <ul>
        <li><strong>Shared test data:</strong> two tests edit the same record. Fix: unique data per test.</li>
        <li><strong>Order dependence:</strong> test B needs data from test A. Fix: each test sets up its own state.</li>
        <li><strong>Async timing:</strong> fixed sleeps before checking an eventual result. Fix: poll with a timeout.</li>
        <li><strong>Unstable environment:</strong> a shared dependency is down or redeploying. Fix: health checks before the run, mocks for third parties.</li>
        <li><strong>Expired tokens</strong> in long runs. Fix: refresh in the auth helper.</li>
        <li><strong>Brittle assertions</strong> on timestamps, list order or generated IDs. Fix: assert on what matters.</li>
        <li><strong>Rate limits</strong> hit by parallel runs.</li>
      </ul>
      <p>I log the full request, response and correlation ID on failure, so I can tell a test bug from a real intermittent product bug. Sometimes the flaky test has found a real race condition.</p>
      <div class="say">I quarantine a flaky test with an owner and a deadline. I don't delete it, and I don't let it keep failing the build at random.</div>` },
    { q: 'What extra risks does GraphQL bring, and how do you test for them?', t: ['GraphQL', 'Security'], a: `
      <p>GraphQL gives clients a lot of power, so the risks are mostly about abuse and hidden failures.</p>
      <ul>
        <li><strong>Errors with 200:</strong> many servers return HTTP 200 with an <code>errors</code> array. Monitoring and tests that only look at status codes miss real failures. I assert on <code>errors</code> in every test, and check dashboards count them.</li>
        <li><strong>Deep or expensive queries:</strong> nested relationships (order, customer, orders, customer...) can explode. I test that depth and complexity limits reject them with a clear error, quickly.</li>
        <li><strong>Aliases and batching:</strong> one request can contain hundreds of copies of the same field or mutation. This can bypass rate limits, for example on login. Limits must count operations, not HTTP requests.</li>
        <li><strong>N+1 queries:</strong> a list query triggering one database call per item. I check response time as list size grows.</li>
        <li><strong>Field-level authorisation:</strong> sensitive fields reachable through a different path in the graph.</li>
        <li><strong>Introspection and suggestions</strong> in production can expose the schema. Whether that's acceptable is a decision to make deliberately.</li>
      </ul>
      <div class="say">With GraphQL, the attack surface is the whole schema, not a list of URLs. I test what someone can reach by walking the graph.</div>` },
    { q: 'What API performance checks would you do as part of functional API testing?', t: ['HTTP & REST', 'Test design'], a: `
      <p>Functional API tests aren't load tests, but they can catch a lot of performance problems early and cheaply.</p>
      <ul>
        <li><strong>Response time budgets:</strong> a loose threshold per endpoint in the regression suite, to catch big regressions such as a query that lost its index.</li>
        <li><strong>Payload size:</strong> responses returning far more data than needed, or no page size cap.</li>
        <li><strong>Scaling with data:</strong> the same call with 10 records and 10,000. If time grows sharply, suspect N+1 queries or missing pagination.</li>
        <li><strong>Caching and compression:</strong> are <code>ETag</code>, <code>Cache-Control</code> and gzip used where they make sense?</li>
        <li><strong>Timeouts:</strong> what does the API do when a dependency is slow? It should fail fast with a clear error, not hang.</li>
        <li><strong>Chatty clients:</strong> a screen that needs 30 calls to render.</li>
      </ul>
      <p>Single-user timings don't tell you about concurrency, so for capacity and SLA questions I hand over to proper load testing with tools like k6 or JMeter, using a realistic workload model. Functional API tests can often be reused as the starting point for those scripts.</p>
      <div class="say">A slow API with one user will only be slower with a thousand. I flag it early instead of waiting for the load test.</div>` },
  ],
};
