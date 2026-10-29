---
title: Mock APIs in Playwright with page.route to test UI against slow or broken backends
date: 2026-11-01
summary: Learn how to use Playwright's page.route to stub API responses, simulate delays, failures or missing endpoints, and keep UI tests reliable.
tags: Playwright, API Testing, Mocking
linkedin: |
  When a backend is slow or missing, UI tests can fail for reasons unrelated to the code under test. I’ve found that mocking API responses with Playwright’s `page.route` gives me fast, deterministic tests. A simple snippet lets me simulate a 1.5‑second delay or a 500 error, and I can assert that the loading spinner or error banner appears. The key takeaway? Keep your mock logic close to the test, use realistic payloads, and always clean up after each run. What’s your go‑to method for mocking slow or broken APIs in Playwright?
---
## Why Mocking Helps
If the backend is flaky, under‑development or simply too slow, UI tests can fail for reasons that have nothing to do with the code under test. By intercepting network traffic you can decouple the UI from the server and make the test deterministic.

## Using page.route
Playwright gives you a `page.route` method that lets you hook into every request that matches a glob pattern. Inside the handler you can decide what to do – return a custom response, delay it, or let it go through.

```js
await page.route('**/api/users', async (route, request) => {
  const mock = { id: 1, name: 'Alice' };
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(mock),
  });
});
```
The example above catches any request that ends with `/api/users` and returns a canned JSON object. The test will never hit the real server.

## Simulating a Slow Response
A common pain point in UI testing is a sluggish API. Playwright can make the request take as long as you like.

```js
await page.route('**/api/orders', async (route, request) => {
  // 1.5 s delay – enough to trigger a loading spinner
  await new Promise(r => setTimeout(r, 1500));
  await route.fulfill({ status: 200, body: '[]' });
});
```
After the delay the UI should show a loading indicator. You can then assert that it disappears once the fake data arrives.

## Simulating a Failure
Sometimes you need to confirm that the UI reacts correctly to a 500 error or a network timeout.

```js
await page.route('**/api/checkout', async route => {
  await route.fulfill({
    status: 500,
    body: 'Internal Server Error',
    contentType: 'text/plain',
  });
});
```
The test can now verify that an error banner appears or that the user is redirected to a retry page.

## Simulating a Missing Endpoint
If the backend hasn’t implemented a route yet, you can abort the request to mimic a 404 or a connection reset.

```js
await page.route('**/api/legacy', route => route.abort());
```
When the abort happens, the browser reports a `net::ERR_ABORTED` error, and you can check that the UI falls back to a placeholder or a friendly message.

## Best Practices

* **Keep mocks next to the test** – this makes the intent obvious.
* **Use exact patterns** – a vague glob can swallow unrelated requests.
* **Return realistic payloads** – a 200 with an empty array is fine, but a 200 with malformed JSON will surface parsing bugs.
* **Clean up** – if you set a route in a `beforeEach`, use `page.unroute` in `afterEach` to avoid state leakage.
* **Avoid hard‑coding delays** – use a small number like 100–200 ms for performance tests, but keep 1–2 s for UI loading scenarios.
* **Leverage context storage** – if you need to change the response on the fly, store state in `page.context().storageState()`.

## Checklist for Mocking with page.route
| Step | What to do | Why |
|------|------------|-----|
| 1 | Define a clear URL pattern | Target only the API you care about |
| 2 | Decide response status | 200 for success, 4xx/5xx for errors |
| 3 | Set `contentType` appropriately | UI may parse JSON or plain text |
| 4 | Add a realistic body | Prevents unexpected parsing failures |
| 5 | Optionally delay with a timeout | Test loading states |
| 6 | Handle aborts for missing endpoints | Simulate 404 or network failure |
| 7 | Clean up routes after each test | Avoid cross‑test contamination |

By following this approach you can write UI tests that are fast, reliable, and independent of the backend’s status. The next time you hit a flaky test, think about whether a mock could be the root cause.
