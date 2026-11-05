# to-k6

Turn a **JMeter test plan, Postman collection, OpenAPI/Swagger spec or curl command** into a [k6](https://k6.io) load test script with one command. It runs offline: your files never leave your machine.

```bash
npx to-k6 plan.jmx > script.js
k6 run script.js
```

These are the same converters as the free browser tools at **[pawansinha.com.au/tools](https://pawansinha.com.au/tools/)**. Use the browser when you want to click through options, and the CLI for scripts, CI and whole folders of plans.

## Install

```bash
npx to-k6 --help        # no install
npm i -g to-k6          # or install it once
```

You need Node.js 18 or newer. k6 itself is a separate install ([k6 install guide](https://grafana.com/docs/k6/latest/set-up/install-k6/)).

## Usage

```bash
to-k6 [type] <file|-> [options] > script.js
```

| Type | Input |
|---|---|
| `jmeter` | JMeter test plan (`.jmx`) |
| `postman` | Postman collection v2.0 / v2.1 (`.json`) |
| `openapi` | OpenAPI 3.x or Swagger 2.0 (`.json`, `.yaml`) |
| `curl` | One or more curl commands, bash or Windows cmd (e.g. Chrome DevTools "Copy as cURL") |

You can leave out the type, and to-k6 works it out from the file.

| Option | What it does |
|---|---|
| `-o, --out <file>` | write to a file instead of stdout |
| `--p95 <ms>` | p95 response-time threshold (default 500, `0` = none) |
| `--error-rate <percent>` | failed-request threshold (default 1) |
| `--vus <n>` | virtual users (postman, openapi, curl) |
| `--duration <d>` | test duration, e.g. `30s`, `5m` |
| `--env <file>` | Postman environment file |
| `--base-url <url>` | override the server URL (openapi) |
| `-q, --quiet` | don't print notes |

### Examples

```bash
# JMeter → k6 (thread groups become scenarios, assertions become checks)
npx to-k6 checkout.jmx -o checkout.js

# Postman collection plus its environment
npx to-k6 postman api.postman_collection.json --env dev.postman_environment.json > api.js

# OpenAPI spec, 20 users for 5 minutes
npx to-k6 openapi.yaml --vus 20 --duration 5m > smoke.js

# curl from the clipboard (macOS)
pbpaste | npx to-k6 curl - > journey.js

# Convert every plan in a folder
for f in plans/*.jmx; do npx to-k6 "$f" -o "k6/$(basename "${f%.jmx}").js"; done
```

## What you get

- A k6 v1.x script on stdout (or in `--out`), with thresholds for p95 and error rate already set.
- Notes on **stderr**: anything that couldn't be converted automatically, and the environment variables the script reads (`k6 run -e NAME=value`). Nothing is dropped silently. Parts that need a person are marked `TODO` in the script.
- Secrets found in headers (tokens, cookies) are moved into environment variables instead of being written into the script.

Check a converted script without running load: `k6 inspect script.js`.

## What JMeter converts

Thread groups (standard, setUp/tearDown, Concurrency and Arrivals plugins), HTTP samplers, HTTP Request Defaults and Header Managers (with JMeter's scoping rules), User Defined Variables, CSV Data Set, Random Variable, Counter, timers, Response/Duration/Size/JSON assertions, Regex/JSON/Boundary/CSS extractors, Transaction/Loop/If/Once Only/Random/Interleave/Throughput/ForEach/Module controllers and common `${__functions}`. The full list and a migration guide are at [pawansinha.com.au/tools/jmeter-to-k6](https://pawansinha.com.au/tools/jmeter-to-k6/).

## Run it in CI with a performance budget

Pair it with the [k6 performance budget GitHub Action](https://github.com/pawansinha0612/k6-performance-budget) to fail a pull request when p95 or the error rate gets worse.

## Need help with a migration or a load test?

I'm a performance engineer in Melbourne. I move JMeter suites to k6 and run load tests before launches and peak sales. **[pawansinha.com.au/services](https://pawansinha.com.au/services/)**

## License

MIT
