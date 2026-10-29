---
title: API testing beyond status 200: a practical checklist
date: 2026-11-04
summary: A concise list of key API tests you can run today – schema, auth, idempotency, pagination, rate limits and more.
tags: API testing, Test automation
linkedin: |
  A 200 status code means the server didn't fail. It doesn't mean the response is right.

  An API can return 200 with a missing field, a null balance, the wrong user's data, or a duplicate order created on retry. A test that only checks the status passes every one of those.

  Beyond 200, check: the response schema, negative and boundary inputs, auth (401 vs 403, expired tokens, scopes), idempotency on retries, pagination, and rate limiting (429 with Retry-After).

  Schema validation is the cheapest place to start: one JSON Schema assertion per endpoint catches missing and renamed fields before clients do.

  What's the bug a status-only test let through on your project?
---
## Why a 200‑only test is incomplete
A 200 status code tells you the server handled the request without failing, but it says nothing about whether the data is right. Imagine a banking API that returns a 200 but an empty balance field. That would pass a simple status check but still break the client. The real work is validating the shape, content and behaviour of the response.

## Schema validation
Validate the JSON or XML structure against a contract. A missing field or an extra one can cause downstream failures. Using a JSON schema library is straightforward. For example, with Python’s `jsonschema`:

```python
from jsonschema import validate

schema = {
    "type": "object",
    "properties": {
        "accountId": {"type": "string"},
        "balance": {"type": "number"}
    },
    "required": ["accountId", "balance"]
}

# response is a dict parsed from the API
validate(instance=response, schema=schema)
```

If the API evolves, the schema test will surface the change early.

## Negative and boundary cases
Happy‑path tests are easy, but real users hit the edges. Test missing required fields, wrong data types, and values outside allowed ranges. For example, send a negative amount to an endpoint that only accepts positive numbers. A 400 error with a clear message is a sign the contract is enforced.

## Authentication and authorisation
Many APIs protect data with OAuth, JWT or API keys. Verify that a request with no or an invalid token returns 401, that a valid token without permission returns 403, and that the right token succeeds. Also check that one user can't read another user's data by changing an ID in the URL. Also test token expiry – a token that should have expired still granting access is a critical bug. Don’t forget scope checks; a token with read‑only scope should not let you POST.

## Idempotency
PUT and DELETE should be idempotent by design: repeating them leaves the same end state. For POST, many APIs (payments especially) accept an idempotency key so a retried request doesn't create a duplicate. Send the same POST twice with the same key, then check that only one resource exists and both responses match. Network retries happen in real life, so this matters more than it looks.

## Pagination
Large result sets are paginated. Verify that page size matches the `limit` parameter, that `next` links or cursors work, that the last page is handled (no endless loop, no error), and that the total count is correct. Also walk all pages and check for duplicates or missing items, which happens when sorting isn't stable.

## Rate limiting
APIs often enforce a request cap. Send a burst of requests beyond the limit and confirm a 429 status with a `Retry‑After` header. Without that header, well-behaved clients can't tell how long to wait and may retry too aggressively.

## Checklist – what to run today
| Test area | What to verify | Tool/technique |
|-----------|----------------|----------------|
| Status code | Should be 200 (or appropriate) | Postman, RestAssured |
| Schema | Matches contract | jsonschema, Ajv, OpenAPI validators |
| Negative cases | 4xx errors for bad input | Postman tests |
| Auth | 401 for missing/expired token, 403 for no permission | Postman, Playwright, curl |
| Idempotency | Same response on repeat | Store response, compare |
| Pagination | Correct `next` link, count | Assertions in test |
| Rate limit | 429 and `Retry‑After` | Load test, API call loop |

Running this checklist before every release catches the most common bugs. It also gives developers confidence that the API behaves predictably.

---

## Keep it maintainable
Store schemas and test data in version control. Automate the checklist in your CI pipeline using a lightweight framework like Pytest or Jest. If a test fails, the message should point to the contract or the endpoint, not a vague “response wrong”.

## Bottom line
A 200 status is only the start. By validating schema, negative cases, auth, idempotency, pagination and rate limits, you turn a simple API call into a robust contract that protects both your service and its consumers.
