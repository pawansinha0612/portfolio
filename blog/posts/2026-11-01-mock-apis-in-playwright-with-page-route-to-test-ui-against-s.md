---
title: Mocking APIs in Playwright with page.route
date: 2026-11-01
summary: Test how your UI handles slow, broken or unfinished backends by intercepting requests with Playwright's page.route. Examples for delays, errors and network failures.
tags: Playwright, API testing, Test automation
linkedin: |
  Your UI tests shouldn't fail because a test environment's backend is slow or down. And you can't easily test your error screens if the backend never fails.

  Playwright's page.route lets a test intercept any request and decide the answer: return canned JSON, add a 3-second delay, send a 500, or drop the connection entirely.

  That means you can check the loading spinner, the error banner and the "try again" button deterministically, every run, without waiting for a real outage.

  One caution: mocked tests prove the UI handles responses correctly. They don't prove the real API sends those responses. Keep a few end-to-end tests against the real backend too.

  Do you mock APIs in your UI tests, or always run against a real backend?
---
UI tests that depend on a real backend inherit all its problems: slow test environments, flaky data, endpoints that aren't built yet. They also make some important behaviour hard to test. How do you check the error banner if the backend never returns an error?

Playwright's `page.route` solves both. It intercepts requests from the page and lets the test decide the response.

## The basics

```javascript
import { test, expect } from '@playwright/test';

test('shows the user list', async ({ page }) => {
  await page.route('**/api/users', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 1, name: 'Alice' }]),
    });
  });

  await page.goto('/users');
  await expect(page.getByText('Alice')).toBeVisible();
});
```

Register the route **before** the action that triggers the request (here, `page.goto`). Any request matching `**/api/users` gets the canned response, and the real server is never called.

`route.fulfill` also accepts a `json` option, which sets the body and content type for you: `route.fulfill({ json: [{ id: 1, name: 'Alice' }] })`.

## Simulating a slow backend

Check that the loading state appears and then goes away:

```javascript
test('shows a spinner while orders load', async ({ page }) => {
  await page.route('**/api/orders', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3000)); // 3 s delay
    await route.fulfill({ json: [] });
  });

  await page.goto('/orders');
  await expect(page.getByRole('progressbar')).toBeVisible();
  await expect(page.getByText('No orders yet')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('progressbar')).toBeHidden();
});
```

## Simulating server errors

```javascript
await page.route('**/api/checkout', (route) =>
  route.fulfill({ status: 500, contentType: 'text/plain', body: 'Internal Server Error' })
);
```

Then assert that the error message and retry option appear. Try 401 (session expired), 404, 429 (rate limited) and 503 as well: each one should lead to a sensible screen, not a blank page.

## Simulating a network failure

`route.abort()` drops the request as if the network failed. It's not an HTTP error; the browser gets no response at all:

```javascript
await page.route('**/api/legacy', (route) => route.abort('connectionrefused'));
```

Other error codes include `'timedout'` and `'internetdisconnected'`. To simulate an endpoint that doesn't exist yet, return a 404 with `route.fulfill({ status: 404 })` instead.

## Changing only part of a real response

Sometimes you want the real response with one field changed, for example to test a very long name or an unusual status. `route.fetch()` calls the real backend so you can edit the result:

```javascript
await page.route('**/api/profile', async (route) => {
  const response = await route.fetch();
  const json = await response.json();
  json.name = 'A'.repeat(200);
  await route.fulfill({ response, json });
});
```

## Tips

- **Use specific URL patterns.** `**/api/**` catches everything, including requests you didn't mean to mock.
- **Keep mock data realistic.** Copy the shape from a real response or the OpenAPI spec, so the UI is tested against what the API actually sends.
- **No clean-up needed between tests.** With Playwright Test, each test gets a fresh page and context, so routes don't leak between tests. Use `page.unroute` only to change behaviour partway through one test.
- **Varying responses:** keep a counter in the handler to return an error on the first call and success on the second, which is a good way to test retry logic.
- **Mock at the context level** with `context.route` if the requests come from pop-ups or several pages.

## Know the limits

Mocked tests prove the UI handles a response correctly. They don't prove the real API returns that response. If the API changes its shape, mocked tests keep passing while production breaks. Balance them with:

- API contract or schema tests against the real backend.
- A small set of end-to-end tests with no mocks, covering the critical journeys.

Used that way, `page.route` gives you fast, deterministic UI tests for the states that are hardest to reproduce: slow, broken and not built yet.
