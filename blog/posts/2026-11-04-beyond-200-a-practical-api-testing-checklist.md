---
title: Beyond 200: A Practical API Testing Checklist
date: 2026-11-04
summary: A concise list of key API tests you can run today – schema, auth, idempotency, pagination, rate limits and more.
tags: API Testing, Automation, Quality Assurance
linkedin: |
  When your API returns 200, are you sure it’s correct? One quick rule: always validate the schema. If the contract doesn’t match the response, clients will break before they even see the error. I added a simple JSON‑schema test to our nightly build and caught a missing field that would have caused a production outage. How do you enforce contract integrity in your tests?
---
## Why a 200‑only test is incomplete
A 200 status code tells you the server accepted the request, but it says nothing about the data you receive. Imagine a banking API that returns a 200 but an empty balance field. That would pass a simple status check but still break the client. The real work is validating the shape, content and behaviour of the response.

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
Many APIs protect data with OAuth, JWT or API keys. Verify that unauthorised requests return a 401 or 403, and that the same request with a valid token succeeds. Also test token expiry – a token that should have expired still granting access is a critical bug. Don’t forget scope checks; a token with read‑only scope should not let you POST.

## Idempotency
Operations that change state should honour idempotency keys. Send the same POST twice with the same key and expect the same result without double‑creating resources. A service that creates a duplicate on repeat breaks consistency. This test is simple: store the first response and compare it to the second.

## Pagination
Large result sets are paginated. Verify that `next` links exist, that page size matches the `limit` parameter, and that the total count is correct. For example, request 50 items per page and assert that the `count` header equals the total number of resources available.

## Rate limiting
APIs often enforce a request cap. Send a burst of requests beyond the limit and confirm a 429 status with a `Retry‑After` header. A missing header can mislead clients into retrying too soon, creating a denial‑of‑service scenario.

## Checklist – what to run today
| Test area | What to verify | Tool/technique |
|-----------|----------------|----------------|
| Status code | Should be 200 (or appropriate) | Postman, RestAssured |
| Schema | Matches contract | jsonschema, Swagger‑Hub |
| Negative cases | 4xx errors for bad input | Postman tests |
| Auth | 401/403 for missing/expired token | Postman, curl |
| Idempotency | Same response on repeat | Store response, compare |
| Pagination | Correct `next` link, count | Assertions in test |
| Rate limit | 429 and `Retry‑After` | Load test, API call loop |

Running this checklist before every release catches the most common bugs. It also gives developers confidence that the API behaves predictably.

---

## Keep it maintainable
Store schemas and test data in version control. Automate the checklist in your CI pipeline using a lightweight framework like Pytest or Jest. If a test fails, the message should point to the contract or the endpoint, not a vague “response wrong”.

## Bottom line
A 200 status is only the start. By validating schema, negative cases, auth, idempotency, pagination and rate limits, you turn a simple API call into a robust contract that protects both your service and its consumers.
