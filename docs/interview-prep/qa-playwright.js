// Playwright automation interview questions and model answers, used by /interview-prep/playwright/ and /interview-prep/practice/.
// Each item: q = question, t = topics (used by the filters), a = model answer (HTML).
(window.QA_TRACKS = window.QA_TRACKS || {}).playwright = {
  basic: [
    { q: 'Why would you choose Playwright over Selenium or Cypress?', t: ['Basics'], a: `
      <ul>
        <li><strong>Auto-waiting built in:</strong> actions wait for the element to be ready, and assertions retry. Most of the hand-written waits you need in Selenium simply go away.</li>
        <li><strong>Browser contexts:</strong> each test gets a fresh, isolated context that is cheap to create. You get clean state without launching a new browser every time.</li>
        <li><strong>Real multi-browser:</strong> Chromium, Firefox and WebKit from one API. WebKit gives you a close stand-in for Safari, which Cypress doesn't cover well.</li>
        <li><strong>No in-browser sandbox limits:</strong> unlike Cypress, it drives the browser from outside, so multiple tabs, multiple origins and multiple users in one test all work.</li>
        <li><strong>One runner for UI and API:</strong> the <code>request</code> fixture, network mocking, tracing, parallelism and sharding come in the box.</li>
      </ul>
      <p>Selenium still wins on language choice and very old browser support. Cypress has a nice interactive runner. For a new TypeScript web project, Playwright is usually my default.</p>
      <div class="say">I pick Playwright because auto-waiting and isolated contexts remove most flakiness at the source, and I get WebKit, API testing and tracing without bolting on extra tools.</div>` },
    { q: 'Explain the browser, context and page model in Playwright.', t: ['Basics'], a: `
      <ul>
        <li><strong>Browser:</strong> one running browser process, such as Chromium. Expensive to start, so it's shared across tests in a worker.</li>
        <li><strong>BrowserContext:</strong> an isolated session inside that browser, like a fresh incognito profile. It has its own cookies, local storage and permissions. Cheap to create.</li>
        <li><strong>Page:</strong> a single tab inside a context. A context can hold many pages.</li>
      </ul>
      <p>Playwright Test gives every test a new <code>context</code> and <code>page</code> through fixtures. That's why tests don't leak login state into each other.</p>
      <pre>test('two users chat', async ({ browser }) =&gt; {
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  // each has separate cookies and storage
});</pre>
      <div class="say">Browser is the process, context is an isolated session, page is a tab. Isolation lives at the context level, which is what makes parallel tests safe.</div>` },
    { q: 'Which locators does Playwright recommend, and why avoid long XPath or CSS chains?', t: ['Locators'], a: `
      <p>Use locators that match how a user or assistive technology sees the page:</p>
      <ol>
        <li><code>page.getByRole('button', { name: 'Place order' })</code> — first choice. It also checks the element is exposed properly to screen readers.</li>
        <li><code>getByLabel</code> for form fields, <code>getByPlaceholder</code>, <code>getByText</code> for non-interactive content.</li>
        <li><code>getByTestId('cart-total')</code> when there is no stable user-facing text. The attribute can be changed with <code>testIdAttribute</code> in config.</li>
      </ol>
      <p>A chain like <code>//div[3]/div/span[2]</code> or <code>.col-md-6 &gt; div:nth-child(2)</code> is tied to layout. A designer moves a div and twenty tests break, though nothing a user cares about changed. Narrow with <code>filter({ hasText })</code> or by chaining from a parent region instead.</p>
      <div class="say">I locate by role and accessible name first, test IDs second, and CSS or XPath only as a last resort. If I can't find a button by its role, that's often an accessibility bug worth raising.</div>` },
    { q: 'What does locator strictness mean, and how do you deal with a strict mode violation?', t: ['Locators', 'Debugging'], a: `
      <p>Locators are <strong>strict</strong>: an action such as <code>click()</code> or <code>fill()</code> fails if the locator matches more than one element. Playwright refuses to guess which one you meant.</p>
      <p>The error lists every match, which helps. The fix is to make the locator more specific, not to silence it:</p>
      <pre>// Too broad: several "Delete" buttons
await page.getByRole('button', { name: 'Delete' }).click();

// Scoped to the right row
await page
  .getByRole('row', { name: /Invoice 1042/ })
  .getByRole('button', { name: 'Delete' })
  .click();</pre>
      <p><code>.first()</code>, <code>.last()</code> and <code>.nth()</code> exist, but they hide intent and break when order changes. I use them only when order is the thing under test. Assertions like <code>toHaveCount</code> work on multiple matches by design.</p>
      <div class="say">Strictness is a feature. It stops a test clicking the wrong thing and passing by accident.</div>` },
    { q: 'What is auto-waiting and what are actionability checks?', t: ['Waits & flakiness'], a: `
      <p>Before Playwright performs an action, it waits until the element is ready for it. For a <code>click()</code> it checks the element is:</p>
      <ul>
        <li><strong>Visible</strong> — has a size and isn't hidden.</li>
        <li><strong>Stable</strong> — not moving or animating.</li>
        <li><strong>Receives events</strong> — not covered by another element such as a spinner overlay.</li>
        <li><strong>Enabled</strong> — not disabled.</li>
      </ul>
      <p><code>fill()</code> also checks the element is <strong>editable</strong>. If the checks don't pass within the action timeout, the test fails with a message saying which check failed.</p>
      <p>This removes the classic Selenium "element not interactable" race. It doesn't wait for your <em>business</em> state, though. If a list loads asynchronously, assert on the content you expect before acting on it.</p>
      <div class="say">Playwright waits for the element to be actionable, so I don't add manual waits. I use assertions to wait for the app to be in the right state.</div>` },
    { q: 'What are web-first assertions, and how do they differ from checking a value yourself?', t: ['Waits & flakiness', 'Basics'], a: `
      <p>Web-first assertions take a locator or page and <strong>retry</strong> until the condition is true or the timeout runs out.</p>
      <pre>// Good: retries until the text appears
await expect(page.getByTestId('status')).toHaveText('Paid');

// Bad: reads once, right now, no retry
expect(await page.getByTestId('status').textContent()).toBe('Paid');</pre>
      <p>The second version is a race. If the status updates 300 ms later, it fails at random. The first is stable and gives a better error message.</p>
      <p>Common ones: <code>toBeVisible</code>, <code>toHaveText</code>, <code>toContainText</code>, <code>toHaveValue</code>, <code>toHaveCount</code>, <code>toHaveURL</code>, <code>toHaveAttribute</code>, <code>toBeEnabled</code>. Negative checks such as <code>not.toBeVisible()</code> also wait properly.</p>
      <div class="say">If I'm asserting on the page, I pass the locator to expect, never a value I've already read. That one habit removes a lot of flaky tests.</div>` },
    { q: 'Why is page.waitForTimeout a bad idea, and what do you use instead?', t: ['Waits & flakiness'], a: `
      <p>A fixed sleep is always wrong in one direction. Too short and the test is flaky on a slow CI runner. Too long and every run wastes time. Across a big suite, those seconds turn into many minutes per pipeline. It also hides the real condition you are waiting for.</p>
      <p>Wait for the thing you actually care about:</p>
      <ul>
        <li>An element or text: <code>await expect(locator).toBeVisible()</code>.</li>
        <li>A navigation: <code>await expect(page).toHaveURL(/\\/orders/)</code>.</li>
        <li>A network call: <code>page.waitForResponse('**/api/orders')</code>, set up <em>before</em> the click that triggers it.</li>
        <li>A spinner to go: <code>await expect(spinner).toBeHidden()</code>.</li>
        <li>A non-UI condition: <code>expect.poll()</code> or <code>expect(...).toPass()</code>.</li>
      </ul>
      <p>I treat <code>waitForTimeout</code> in a pull request as a review comment every time. The docs themselves say it's for debugging only.</p>
      <div class="say">A sleep is a guess. I replace it with an assertion on the state the test really depends on.</div>` },
    { q: 'What do you usually put in playwright.config.ts?', t: ['Basics', 'CI/CD'], a: `
      <pre>import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 4 : undefined,
  reporter: [['html', { open: 'never' }], ['junit', { outputFile: 'results.xml' }]],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});</pre>
      <p><code>baseURL</code> lets tests call <code>page.goto('/login')</code> and switch environments by variable. <code>retries</code> only in CI, so flakiness shows locally. <code>trace: 'on-first-retry'</code> keeps a full trace for failures without slowing green runs. <code>projects</code> run the same tests per browser or device. <code>forbidOnly</code> stops a stray <code>test.only</code> from passing CI.</p>` },
    { q: 'A test fails on your machine. What tools do you use to debug it?', t: ['Debugging'], a: `
      <ul>
        <li><strong>UI mode</strong> — <code>npx playwright test --ui</code>. Watch mode, a timeline of each step, DOM snapshots before and after every action, and a locator picker. My default.</li>
        <li><strong>Inspector</strong> — <code>npx playwright test login.spec.ts --debug</code>. Runs headed and pauses on each action so you can step through. <code>await page.pause()</code> stops at a chosen line.</li>
        <li><strong>Trace viewer</strong> — <code>npx playwright show-trace trace.zip</code>. Actions, network, console, and snapshots. The same file CI produces.</li>
        <li><strong>Codegen</strong> — <code>npx playwright codegen https://example.com</code>. Records actions and suggests locators. Good for finding a locator, not for writing the final test.</li>
        <li><strong>VS Code extension</strong> — run, debug with breakpoints and pick locators from the editor.</li>
      </ul>
      <p>I also read the error properly first. Playwright usually tells you which actionability check failed or which locator matched too many elements.</p>
      <div class="say">I start with UI mode or the trace, because they show what the page looked like at the moment it failed. Guessing comes last.</div>` },
    { q: 'How do you write a simple API test in Playwright?', t: ['API testing', 'Basics'], a: `
      <p>Use the built-in <code>request</code> fixture. It's an <code>APIRequestContext</code> that picks up <code>baseURL</code> and <code>extraHTTPHeaders</code> from config. No browser is launched.</p>
      <pre>import { test, expect } from '@playwright/test';

test('creates a customer', async ({ request }) =&gt; {
  const res = await request.post('/api/customers', {
    data: { name: 'Test Customer', email: 'qa+1@example.com' },
  });
  await expect(res).toBeOK();

  const body = await res.json();
  expect(body).toMatchObject({ name: 'Test Customer' });

  const get = await request.get(\`/api/customers/\${body.id}\`);
  expect(get.status()).toBe(200);
});</pre>
      <p><code>data</code> is sent as JSON. Use <code>form</code> or <code>multipart</code> for other bodies, and <code>params</code> for query strings. <code>toBeOK()</code> passes for any 2xx status. Check the specific code and the body shape too, not just that it didn't fail.</p>
      <div class="say">The same runner, reports and CI setup cover UI and API tests, which keeps the framework simple.</div>` },
  ],
  intermediate: [
    { q: 'What are fixtures, and what is the difference between test and worker scope?', t: ['Fixtures', 'TypeScript'], a: `
      <p>Fixtures are how Playwright Test sets up and tears down what a test needs. <code>page</code>, <code>context</code> and <code>request</code> are built-in fixtures. You add your own with <code>test.extend</code>. Code before <code>use()</code> is setup, code after is teardown, and a fixture only runs if a test asks for it.</p>
      <pre>type Fixtures = { cartPage: CartPage };
type WorkerFixtures = { apiToken: string };

export const test = base.extend&lt;Fixtures, WorkerFixtures&gt;({
  cartPage: async ({ page }, use) =&gt; {
    await use(new CartPage(page));
  },
  apiToken: [async ({}, use) =&gt; {
    const token = await fetchServiceToken();
    await use(token);
  }, { scope: 'worker' }],
});</pre>
      <ul>
        <li><strong>Test scope</strong> (default): created fresh for each test. Use it for anything holding state.</li>
        <li><strong>Worker scope</strong>: created once per worker process and shared by its tests. Use it for expensive, read-only things such as a service token or a seeded account.</li>
      </ul>
      <div class="say">Fixtures give me setup, teardown and typing in one place, and tests only pay for what they ask for.</div>` },
    { q: 'Page Object Model or fixtures? How do you structure a Playwright framework?', t: ['Framework design', 'Fixtures'], a: `
      <p>It isn't either/or. I use both, for different jobs:</p>
      <ul>
        <li><strong>Page objects</strong> hold locators and user-level actions for one page or component, such as <code>checkout.payWithCard()</code>. Keep them thin. No assertions hidden inside unless the method is literally a check.</li>
        <li><strong>Fixtures</strong> create and inject those page objects, plus test data, logged-in state and API clients. Tests stop doing <code>new LoginPage(page)</code> everywhere.</li>
      </ul>
      <pre>test('pays by card', async ({ checkoutPage, seededCart }) =&gt; {
  await checkoutPage.open(seededCart.id);
  await checkoutPage.payWithCard('4242424242424242');
  await expect(checkoutPage.confirmation).toBeVisible();
});</pre>
      <p>Things I avoid: deep inheritance trees of base pages, page objects that wrap every Playwright call, and "util" classes that grow without limit. Prefer components (header, data table) that pages compose.</p>
      <div class="say">Page objects describe the UI, fixtures wire everything together, and the test reads like the acceptance criteria.</div>` },
    { q: 'How do you handle login so every test doesn\'t go through the login screen?', t: ['Fixtures', 'Framework design'], a: `
      <p>Log in once in a <strong>setup project</strong>, save the browser state with <code>storageState</code>, and have other projects start with it.</p>
      <pre>// auth.setup.ts
import { test as setup } from '@playwright/test';
const authFile = 'playwright/.auth/user.json';

setup('authenticate', async ({ page }) =&gt; {
  await page.goto('/login');
  await page.getByLabel('Email').fill(process.env.TEST_USER!);
  await page.getByLabel('Password').fill(process.env.TEST_PASS!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/dashboard');
  await page.context().storageState({ path: authFile });
});

// playwright.config.ts
projects: [
  { name: 'setup', testMatch: /.*\\.setup\\.ts/ },
  { name: 'chromium', dependencies: ['setup'],
    use: { ...devices['Desktop Chrome'], storageState: authFile } },
],</pre>
      <p>Logging in through the API in setup is even faster. Keep the <code>.auth</code> folder out of git. For a logged-out test, override with <code>test.use({ storageState: { cookies: [], origins: [] } })</code>. Keep one real UI login test so the login page itself is still covered.</p>` },
    { q: 'How do you combine API calls with UI tests?', t: ['API testing', 'Framework design'], a: `
      <p>Use the API for <strong>setup and teardown</strong>, and the UI only for the behaviour under test. Creating an order through five screens just to test the refund button is slow and makes the test fail for unrelated reasons.</p>
      <pre>test('customer can cancel a pending order', async ({ page, request }) =&gt; {
  const res = await request.post('/api/orders', { data: { sku: 'ABC-1', qty: 1 } });
  await expect(res).toBeOK();
  const order = await res.json();

  await page.goto(\`/orders/\${order.id}\`);
  await page.getByRole('button', { name: 'Cancel order' }).click();
  await expect(page.getByText('Cancelled')).toBeVisible();

  const check = await request.get(\`/api/orders/\${order.id}\`);
  expect((await check.json()).status).toBe('CANCELLED');
});</pre>
      <p><code>page.request</code> shares cookies with the browser context, so API calls run as the logged-in user. Better still, wrap this in a fixture that creates the order and deletes it after <code>use()</code>.</p>
      <div class="say">API for arranging state, UI for the behaviour, API again to check the backend agreed. Tests get faster and fail only for the right reasons.</div>` },
    { q: 'How and when do you mock network requests with page.route?', t: ['API testing', 'Waits & flakiness'], a: `
      <p><code>page.route</code> intercepts matching requests so you can fulfil, change or block them.</p>
      <pre>// Return a fixed response
await page.route('**/api/products', route =&gt;
  route.fulfill({ json: [{ id: 1, name: 'Widget', price: 9.5 }] }));

// Force an error state
await page.route('**/api/payments', route =&gt; route.fulfill({ status: 503 }));

// Patch the real response
await page.route('**/api/profile', async route =&gt; {
  const response = await route.fetch();
  const json = await response.json();
  await route.fulfill({ response, json: { ...json, plan: 'premium' } });
});</pre>
      <p>Set routes <em>before</em> the navigation or click that triggers the request. <code>route.abort()</code> blocks things like analytics. <code>page.routeFromHAR</code> replays a recorded set of responses.</p>
      <p><strong>Good uses:</strong> error and empty states, slow third parties, edge cases that are hard to create. <strong>Risk:</strong> mocks drift from the real API, and tests pass against a contract that no longer exists. I keep a smaller unmocked end-to-end set and back mocks with API or contract tests.</p>` },
    { q: 'How do you handle iframes, new tabs, downloads, file uploads and dialogs?', t: ['Locators', 'Basics'], a: `
      <pre>// iframe
await page.frameLocator('#payment-frame').getByLabel('Card number').fill('4242...');

// new tab: start waiting before the click
const popupPromise = page.waitForEvent('popup');
await page.getByRole('link', { name: 'Terms' }).click();
const popup = await popupPromise;
await expect(popup).toHaveTitle(/Terms/);

// download
const downloadPromise = page.waitForEvent('download');
await page.getByRole('button', { name: 'Export CSV' }).click();
const download = await downloadPromise;
expect(download.suggestedFilename()).toBe('orders.csv');

// upload
await page.getByLabel('Attachment').setInputFiles('fixtures/invoice.pdf');

// dialog: dismissed by default, so register a handler first
page.once('dialog', dialog =&gt; dialog.accept());
await page.getByRole('button', { name: 'Delete' }).click();</pre>
      <p>The common pattern is <strong>start waiting for the event, then trigger it</strong>. If you click first, the event can fire before you start listening.</p>
      <div class="say">For anything event-driven I create the promise before the action and await it after. That ordering is where most bugs in these tests come from.</div>` },
    { q: 'How does Playwright run tests in parallel, and how do you keep them isolated?', t: ['Framework design', 'CI/CD'], a: `
      <p>Tests run in <strong>worker processes</strong>. By default, files run in parallel and tests within a file run in order. <code>fullyParallel: true</code> spreads individual tests across workers too. <code>workers</code> sets how many processes run.</p>
      <p>Each test gets a fresh context, so browser state is isolated for free. The real risk is <strong>shared backend data</strong>:</p>
      <ul>
        <li>Two tests editing the same user, or one test asserting "3 items in the list" while another adds one.</li>
        <li>Tests that rely on another test having run first.</li>
      </ul>
      <p>Fixes: each test creates its own data with unique names, worker-scoped accounts keyed by <code>testInfo.parallelIndex</code>, and assertions on "my record exists" rather than global counts.</p>
      <p><code>test.describe.configure({ mode: 'serial' })</code> exists, but if one test fails the rest are skipped, and it hides dependency problems. I use it rarely and on purpose.</p>
      <div class="say">If a test can't run alone, in any order, on any worker, it isn't finished yet.</div>` },
    { q: 'A test passes locally but fails intermittently in CI. How do you diagnose it?', t: ['Debugging', 'Waits & flakiness'], a: `
      <ol>
        <li><strong>Get the trace.</strong> With <code>trace: 'on-first-retry'</code> the CI artefact has it. Open it at trace.playwright.dev or with <code>show-trace</code>. Check the action that failed, the DOM snapshot, the network tab and the console.</li>
        <li><strong>Reproduce the pressure.</strong> Run <code>--repeat-each=20</code> with several workers, or <code>--workers=1</code> to rule out data clashes. Throttle with a CI-like machine or the Docker image.</li>
        <li><strong>Classify the cause:</strong>
          <ul>
            <li>A race: a value read once instead of a web-first assertion, or listening for an event too late.</li>
            <li>Shared data between parallel tests.</li>
            <li>Environment: slow third party, different timezone, locale or screen size.</li>
            <li>A real app bug, such as a double submit or a missing loading state.</li>
          </ul>
        </li>
        <li><strong>Fix the cause</strong>, not the symptom. Raising timeouts or adding retries just hides it.</li>
      </ol>
      <div class="say">Flaky means there's a race somewhere, sometimes in the test, sometimes in the product. The trace usually shows me which within a few minutes.</div>` },
    { q: 'How do you use tags, grep, annotations and test.step?', t: ['Framework design', 'Debugging'], a: `
      <pre>test('checkout with saved card', {
  tag: ['@smoke', '@payments'],
  annotation: { type: 'issue', description: 'JIRA-1234' },
}, async ({ page }) =&gt; {
  await test.step('add item to cart', async () =&gt; {
    await page.goto('/products/abc');
    await page.getByRole('button', { name: 'Add to cart' }).click();
  });
  await test.step('pay', async () =&gt; {
    // ...
  });
});</pre>
      <ul>
        <li><strong>Tags</strong> select subsets: <code>npx playwright test --grep @smoke</code>, or <code>--grep-invert @slow</code>. Use them for a fast pull-request suite and a full nightly run. Config also supports <code>grep</code> per project.</li>
        <li><strong>Annotations</strong> attach metadata such as a ticket link, shown in the HTML report. <code>test.fixme</code>, <code>test.skip</code> and <code>test.slow</code> are built-in ones.</li>
        <li><strong>test.step</strong> groups actions into named steps in the report and trace, so a failure reads "failed in step: pay" rather than at line 47. Steps can return values.</li>
      </ul>
      <div class="say">Tags decide what runs when, and steps make the report readable for someone who didn't write the test.</div>` },
    { q: 'When would you use soft assertions, expect.poll and toPass?', t: ['Waits & flakiness', 'Debugging'], a: `
      <p><strong>Soft assertions</strong> record a failure but let the test carry on, so you see every problem in one run:</p>
      <pre>await expect.soft(page.getByTestId('subtotal')).toHaveText('$90.00');
await expect.soft(page.getByTestId('gst')).toHaveText('$9.00');
await expect.soft(page.getByTestId('total')).toHaveText('$99.00');</pre>
      <p>Good for checking many fields on one screen. Don't use them before an action that depends on the earlier check passing.</p>
      <p><strong>expect.poll</strong> retries any async function, useful for non-UI state:</p>
      <pre>await expect.poll(async () =&gt; {
  const res = await request.get(\`/api/jobs/\${id}\`);
  return (await res.json()).status;
}, { timeout: 30_000 }).toBe('COMPLETE');</pre>
      <p><strong>toPass</strong> retries a whole block of code, including several assertions, until it passes: <code>await expect(async () =&gt; { ... }).toPass({ timeout: 10_000 })</code>.</p>
      <div class="say">Soft assertions for many independent checks, poll for waiting on a backend, toPass when a group of steps needs retrying together. None of them replace a plain web-first assertion where one fits.</div>` },
  ],
  advanced: [
    { q: 'How would you scale a Playwright suite to more than 1,000 tests and keep feedback fast?', t: ['Framework design', 'CI/CD'], a: `
      <ul>
        <li><strong>Shape the pyramid:</strong> push logic checks down to API and component tests. Keep end-to-end UI tests for real user journeys.</li>
        <li><strong>Parallelise:</strong> <code>fullyParallel: true</code>, then split across machines with <code>--shard=1/8</code> and so on. Each shard writes a <code>blob</code> report, and <code>npx playwright merge-reports</code> combines them into one HTML report.</li>
        <li><strong>Tiered runs:</strong> tag a <code>@smoke</code> set for every pull request, run the full set on merge or nightly. <code>--only-changed</code> and <code>--last-failed</code> help locally.</li>
        <li><strong>Cut setup cost:</strong> <code>storageState</code> for login, API seeding instead of UI setup, worker-scoped fixtures for expensive resources.</li>
        <li><strong>Data isolation:</strong> unique data per test, so adding workers doesn't add flakiness.</li>
        <li><strong>Watch suite health:</strong> track duration and flaky rate per test over time. Slow and flaky tests get fixed or deleted, not tolerated.</li>
      </ul>
      <p>Balance shards by duration. One very long file can make a single shard the bottleneck, so <code>fullyParallel</code> matters for sharding too.</p>
      <div class="say">Speed at scale comes from fewer, better UI tests, isolated data and sharding. Adding machines to a suite full of dependencies only makes it flakier, faster.</div>` },
    { q: 'How do you run Playwright in CI, for example on GitHub Actions?', t: ['CI/CD'], a: `
      <pre>jobs:
  e2e:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: lts/* }
      - run: npm ci
      - run: npx playwright install --with-deps
      - run: npx playwright test --shard=\${{ matrix.shard }}/4
      - uses: actions/upload-artifact@v4
        if: \${{ !cancelled() }}
        with:
          name: blob-report-\${{ matrix.shard }}
          path: blob-report</pre>
      <p>A follow-up job downloads the blobs and runs <code>merge-reports</code>. The key points:</p>
      <ul>
        <li><strong>Pin the environment.</strong> The official Docker image (<code>mcr.microsoft.com/playwright</code>) has browsers and OS dependencies ready. Pin its tag to the same version as <code>@playwright/test</code>. This matters a lot for screenshot tests.</li>
        <li><strong>Always upload artefacts</strong>, including on failure: the HTML report and traces.</li>
        <li><strong>JUnit output</strong> for the CI test tab, <code>forbidOnly</code>, and retries only in CI.</li>
        <li>Secrets come from the CI secret store, never the repo.</li>
      </ul>` },
    { q: 'How do you do visual regression testing with toHaveScreenshot, and what are the pitfalls?', t: ['Visual & a11y'], a: `
      <pre>await expect(page).toHaveScreenshot('pricing.png', {
  fullPage: true,
  mask: [page.getByTestId('live-clock'), page.locator('.ad-slot')],
  animations: 'disabled',
  maxDiffPixelRatio: 0.01,
});</pre>
      <p>The first run writes a baseline. Later runs compare against it, and the HTML report shows expected, actual and diff. Update baselines on purpose with <code>--update-snapshots</code>, and review the image changes in the pull request.</p>
      <p><strong>Pitfalls:</strong></p>
      <ul>
        <li><strong>Rendering differs by OS and browser.</strong> Baselines get a browser and platform suffix. Generate and compare in the same Docker image, or Mac and Linux will never agree.</li>
        <li><strong>Dynamic content:</strong> dates, avatars, ads, carousels. Mask them, mock the data, or fix time with <code>page.clock</code>.</li>
        <li><strong>Fonts and lazy images</strong> not loaded yet.</li>
        <li><strong>Loose thresholds</strong> that let real bugs through, or tight ones that fail on anti-aliasing.</li>
        <li><strong>Too many full-page shots.</strong> Prefer screenshots of key components with a locator.</li>
      </ul>
      <div class="say">Visual tests are cheap to write and expensive to maintain. I keep them few, deterministic and generated in one pinned environment.</div>` },
    { q: 'How do you add accessibility testing to a Playwright suite?', t: ['Visual & a11y'], a: `
      <p>Use <code>@axe-core/playwright</code> to run the axe engine against the live page:</p>
      <pre>import AxeBuilder from '@axe-core/playwright';

test('checkout has no detectable WCAG A/AA issues', async ({ page }) =&gt; {
  await page.goto('/checkout');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .exclude('#third-party-chat')
    .analyze();
  expect(results.violations).toEqual([]);
});</pre>
      <ul>
        <li>Scan the page in meaningful states too: modal open, form errors showing, menu expanded.</li>
        <li>On a legacy app, start with a baseline of known issues and fail only on <em>new</em> violations, so the check can ship without blocking everyone.</li>
        <li>Wrap it in a fixture so every team scans the same way with the same tags.</li>
        <li><code>toMatchAriaSnapshot</code> can lock down the accessible structure of a component.</li>
      </ul>
      <p>Be honest about the limits. Automated tools catch only part of WCAG issues. Keyboard flow, focus order, meaning of alt text and screen reader experience still need manual checks.</p>
      <div class="say">Role-based locators already push us towards accessible markup. axe in CI catches regressions, and manual audits cover what tools can't.</div>` },
    { q: 'What is your test data strategy for a large parallel Playwright suite?', t: ['Framework design', 'API testing'], a: `
      <p>The rule: <strong>every test owns its data</strong>, or reads data nobody changes.</p>
      <ul>
        <li><strong>Create through the API</strong> in a fixture, with unique values (a short random suffix or <code>testInfo.testId</code>). Clean up after <code>use()</code>, or tag records so a nightly job removes them.</li>
        <li><strong>Read-only reference data</strong> such as products or postcodes can be seeded once per environment.</li>
        <li><strong>Accounts per worker</strong> when creating users is slow: a worker-scoped fixture picks <code>user-\${workerInfo.parallelIndex}</code>, so two workers never share a login.</li>
        <li><strong>Builders or factories</strong> with sensible defaults: <code>buildOrder({ status: 'PENDING' })</code>. Tests state only what matters to them.</li>
        <li><strong>No dependency on test order</strong> and no "test 1 creates, test 5 deletes".</li>
        <li><strong>Mocks</strong> for states the backend can't easily produce, such as a payment provider timeout.</li>
      </ul>
      <p>Also check where the data lives. Shared test environments get reset or used by other teams, so tests shouldn't assume a clean database.</p>
      <div class="say">Most flakiness I see at scale is really data contention. Unique, self-owned data fixes it more reliably than any retry setting.</div>` },
    { q: 'How do you use TypeScript to make a Playwright framework safer and easier to maintain?', t: ['TypeScript', 'Framework design'], a: `
      <ul>
        <li><strong>Typed fixtures</strong> via <code>test.extend&lt;MyFixtures, MyWorkerFixtures&gt;</code>, so tests get autocomplete and a typo in a fixture name is a compile error.</li>
        <li><strong>Typed API responses.</strong> Define response types, and validate at runtime with a schema library such as Zod. A type alone only describes what you hope comes back.</li>
        <li><strong>Typed config and environment.</strong> Read <code>process.env</code> once in a small module that fails fast on missing values, rather than <code>!</code> scattered everywhere.</li>
        <li><strong>Union types</strong> for things like roles: <code>type Role = 'admin' | 'agent' | 'customer'</code>, so <code>loginAs('admn')</code> doesn't compile.</li>
        <li><strong>Lint rules:</strong> <code>@typescript-eslint/no-floating-promises</code> catches a missing <code>await</code>, one of the most common causes of odd failures. The ESLint Playwright plugin flags things like <code>waitForTimeout</code>.</li>
        <li>Run <code>tsc --noEmit</code> in CI. Playwright strips types when running, so it won't stop on type errors by itself.</li>
      </ul>
      <div class="say">Playwright runs TypeScript but doesn't type-check it, so I add tsc and a no-floating-promises lint rule to the pipeline. A missing await is the bug that rule catches most.</div>` },
    { q: 'How would you lead a migration from Selenium to Playwright?', t: ['Framework design', 'Basics'], a: `
      <ol>
        <li><strong>Make the case with a pilot.</strong> Port a small, painful area, such as the flakiest journeys. Compare run time, flaky rate and maintenance effort with real data from both.</li>
        <li><strong>Don't translate line by line.</strong> Selenium suites are full of explicit waits, sleeps, XPath and retry wrappers. Rewrite with role locators and web-first assertions, or you just move the flakiness.</li>
        <li><strong>Review the coverage, don't copy it.</strong> Many old UI tests should become API tests or be deleted.</li>
        <li><strong>Build the foundation first:</strong> config, fixtures, auth setup, data factories, CI and reporting. Then teams port tests onto a working base.</li>
        <li><strong>Run both suites in parallel</strong> for a while. Retire a Selenium area only when the Playwright version is stable and covers the same risk.</li>
        <li><strong>Train the team:</strong> pairing, a short coding standard, and examples of good tests to copy.</li>
      </ol>
      <p>Watch for gaps: Selenium Grid setups, non-JavaScript teams who need support, or old browsers Playwright doesn't target.</p>
      <div class="say">A migration is a chance to rethink the suite, not a rewrite of the same problems in a new tool. I'd prove it on the worst area first and let the numbers sell it.</div>` },
    { q: 'How do you manage flaky tests and retries across a large team?', t: ['Waits & flakiness', 'CI/CD'], a: `
      <p>Retries are a safety net, not a fix. A test that fails then passes on retry is marked <strong>flaky</strong> in the report, and that signal should be acted on, not ignored.</p>
      <ul>
        <li><strong>Retries in CI only</strong>, usually 1 or 2, with <code>trace: 'on-first-retry'</code> so every flaky run leaves evidence.</li>
        <li><strong>Track it.</strong> Push results (JUnit or a custom reporter) into a dashboard, and rank tests by flaky rate over the last weeks.</li>
        <li><strong>Quarantine with ownership.</strong> Move a chronic offender to a non-blocking tag such as <code>@quarantine</code>, raise a ticket with an owner and a deadline. Fix it or delete it.</li>
        <li><strong>Prevent it.</strong> Lint rules, review checklists (no sleeps, no value reads in assertions, unique data), and <code>--repeat-each</code> on new tests before merge.</li>
        <li><strong>Separate product bugs.</strong> Some flakiness is a real race in the app. That goes to the developers, not the test backlog.</li>
      </ul>
      <p>Avoid raising global timeouts to hide problems. It slows every failure and fixes nothing.</p>
      <div class="say">The goal is that a red build always means something. Once people start re-running pipelines by habit, the suite has lost its value.</div>` },
    { q: 'How do you test a flow that needs two users at once, such as an agent and a customer?', t: ['Fixtures', 'Framework design'], a: `
      <p>Create one browser context per user inside the same test. Each has its own cookies and storage, so they behave like two separate people.</p>
      <pre>test('agent sees the customer message', async ({ browser }) =&gt; {
  const agentCtx = await browser.newContext({ storageState: 'playwright/.auth/agent.json' });
  const customerCtx = await browser.newContext({ storageState: 'playwright/.auth/customer.json' });
  const agent = await agentCtx.newPage();
  const customer = await customerCtx.newPage();

  await agent.goto('/inbox');
  await customer.goto('/support');
  await customer.getByLabel('Message').fill('Where is my order?');
  await customer.getByRole('button', { name: 'Send' }).click();

  await expect(agent.getByText('Where is my order?')).toBeVisible();

  await agentCtx.close();
  await customerCtx.close();
});</pre>
      <p>Save a storage state per role in the setup project. For reuse, wrap each role in a fixture that creates and closes its context, so tests just ask for <code>agentPage</code> and <code>customerPage</code>.</p>
      <div class="say">This is where Playwright's context model really pays off. Two isolated users in one test, one browser, no extra infrastructure.</div>` },
    { q: 'How far do you take API testing in Playwright, and where would you use something else?', t: ['API testing', 'TypeScript'], a: `
      <p>Playwright's <code>APIRequestContext</code> is good for functional API tests: status codes, response bodies, auth rules, negative cases and multi-step flows. It shares config, fixtures and reports with the UI suite.</p>
      <pre>const api = await playwright.request.newContext({
  baseURL: process.env.API_URL,
  extraHTTPHeaders: { Authorization: \`Bearer \${token}\` },
});
const res = await api.post('/orders', { data: { qty: -1 } });
expect(res.status()).toBe(400);
expect(await res.json()).toMatchObject({ error: expect.stringContaining('qty') });
await api.dispose();</pre>
      <p>What I add or use elsewhere:</p>
      <ul>
        <li><strong>Schema checks:</strong> validate responses against the OpenAPI spec or a Zod schema, not just a few fields.</li>
        <li><strong>Contract testing</strong> between services: a tool such as Pact is a better fit.</li>
        <li><strong>Load testing:</strong> not Playwright. Use k6, JMeter or Gatling.</li>
        <li><strong>Security testing</strong> needs dedicated tools, though auth and permission checks fit well here.</li>
      </ul>
      <div class="say">Playwright covers functional API testing well, especially next to the UI tests. Contracts, load and security each have better tools.</div>` },
  ],
};
