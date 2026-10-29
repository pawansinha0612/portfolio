---
title: Using AI to write test cases: where to trust it and where to check
date: 2026-11-02
summary: AI drafts test cases fast, but it only knows what you tell it. Prompts that work, what it gets wrong, and a review checklist.
tags: AI, QA, Test design
linkedin: |
  AI can write twenty test cases in the time it takes to write one. The catch: it only knows what you put in the prompt.

  Give it the endpoint, the fields, the validation rules and the expected status codes, and you get a useful first draft of positive, negative and boundary cases.

  Leave out the business rules, and it will confidently invent them.

  A simple rule for review: if a test checks *what* the system does (fields, formats, status codes), a quick check is usually enough. If it checks *why* (a business rule, a calculation, a state change), a person who knows the domain has to review it.

  Where has AI helped your test design the most, and where has it got things wrong?
---
## Why use AI to write test cases?
Writing test cases is often repetitive: the same positive, negative and boundary patterns applied to field after field. AI can draft that first version quickly. It's not a replacement for test design, but it is a useful drafting tool.

## What AI can do well
AI excels at
* generating standard CRUD tests from a data model
* creating edge‑case skeletons when you give it a clear requirement
* producing API payloads when you provide the endpoint schema

When the prompt is specific, the output is often usable right away.

## What AI struggles with
1. **Business logic that isn't in the prompt.** It doesn't know your domain rules, and it may invent plausible-looking ones.
2. **Contextual dependencies** – tests that depend on previous steps or data states.
3. **Regulatory or compliance checks** – you must verify that the test meets legal standards.

In short, AI is great for the mechanical parts, not the nuanced parts.

## Crafting a useful prompt
A good prompt follows a simple pattern:

```
You are a QA engineer. Write a functional test case for the "Create Order" API. The API requires:
- POST /orders
- Body: {"customerId": int, "items": [{"productId": int, "qty": int}]}
- Success status: 201
- Validation: total price must be > 0, qty > 0
Include steps, expected results, and a sample payload.
```

Notice the prompt:
* States the role
* Gives the endpoint and data
* Lists success criteria
* Asks for steps and payload

Any missing detail invites guesswork.

## Checklist for reviewing AI‑generated test cases
| Item | Why it matters | How to check |
|------|----------------|--------------|
| Data types match the API spec | Prevents runtime errors | Cross‑reference the schema |
| Edge‑case conditions are present | Ensures robustness | Verify with a risk matrix |
| Expected status codes are correct | Accurate coverage | Match against documentation |
| Test description is clear | Easy to maintain | Read aloud to a teammate |
| No duplicate steps | Avoids wasted effort | Compare with existing test suite |
| Compliance fields are included | Meets legal standards | Consult the compliance checklist |
| No invented rules or limits | AI fills gaps with guesses | Trace each expected result to a requirement |

If any row raises a concern, bring the test back to the team.

## When to trust the AI output
* Simple CRUD operations where the schema is static.
* UI input validation tests that follow a clear pattern.
* API endpoint checks that rely solely on the request/response contract.

In these cases, the AI often needs only a quick syntax fix.

## When to insist on human review
* Tests that involve business rules or calculations.
* End‑to‑end flows spanning multiple services.
* Security or performance checks where context matters.
* Documentation or compliance‑related tests.

A quick rule of thumb: **If the test touches a “why” rather than a "what”, review it.**

## A practical example
Suppose your banking app has a transfer endpoint. An AI prompt might look like:

```
You are a QA engineer. Write a test case for the "Transfer Funds" API.
Requirements:
- Endpoint: POST /transfer
- Body: {"fromAccount": "string", "toAccount": "string", "amount": decimal}
- Success status: 200
- Business rule: amount must be less than the balance of fromAccount
- Edge case: transfer amount equal to balance
Include steps, expected results, and a sample payload.
```

The AI will likely generate a payload and steps, but it will not know the actual balances. A human must insert realistic values and verify the business rule.

## Decision rule for acceptance
1. **Does the test cover a technical requirement only?** – Accept after syntax check.
2. **Does the test involve a business rule or state?** – Review and adjust.
3. **Is the test data realistic?** – Check it against the spec and your test environment data. Never paste real customer data into an AI tool.
4. **Does the test meet compliance?** – Flag for compliance team.

Follow this flow in a pull‑request review or a dedicated test‑case audit.

## Bottom line
AI can accelerate test‑case creation, especially for repetitive patterns. However, it is not a silver bullet. A disciplined review process, guided by a simple checklist, ensures that the final test suite is accurate, maintainable, and compliant.

Adopt AI as a drafting assistant, not a final author. The human touch remains the safety net.
