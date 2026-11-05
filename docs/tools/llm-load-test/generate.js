/* LLM endpoint → k6 load test generator. Runs in the browser (window.LlmToK6) and in Node (module.exports), so it
   can be unit-tested and later added to the to-k6 CLI. Nothing is sent anywhere: the script is built on the
   visitor's machine, and the API key is never written into it (the script reads __ENV.LLM_API_KEY).

   Provider shapes:
     openai    OpenAI-compatible /chat/completions (OpenAI, OpenRouter, Groq, Together, vLLM, Ollama, LiteLLM, ...)
     azure     Azure OpenAI deployments (api-key header, api-version query, no model in the body)
     anthropic Anthropic Messages API (/v1/messages)
     custom    any JSON endpoint: a body template with {{prompt}}, {{model}} and {{max_tokens}}, plus dot paths to the
               generated text and token counts in the response

   What the generated script measures (custom k6 metrics):
     llm_ttft              time to first token. k6's HTTP client can't read a response while it streams, so this is
                           timings.waiting (time to first byte). With streaming on, most providers send the first byte
                           with the first token, so it is a close approximation. A proxy that flushes headers early
                           makes it look faster than it is. Only recorded when streaming is on.
     llm_latency           full response time of successful requests
     llm_output_tokens_per_s  generation speed: output tokens ÷ (latency − TTFT) when streaming, ÷ latency otherwise
     llm_input_tokens / llm_output_tokens  token counters (from the response's usage block, or estimated at 4 chars a
                           token when the provider doesn't return usage, counted in llm_tokens_estimated)
     llm_rate_limited      share of attempts answered with 429
     llm_errors            share of requests that failed after retries (non-2xx, error event or empty answer)
     llm_retries           how many 429 retries were made
   handleSummary adds a cost estimate from the prices per 1M tokens entered in the tool. Output targets k6 v1.x. */
(function (root) {
  'use strict';

  const PROVIDERS = {
    openai: { label: 'OpenAI-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', auth: 'bearer' },
    azure: { label: 'Azure OpenAI', baseUrl: 'https://YOUR-RESOURCE.openai.azure.com', model: 'YOUR-DEPLOYMENT', auth: 'api-key' },
    anthropic: { label: 'Anthropic Messages', baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-4-5', auth: 'x-api-key' },
    custom: { label: 'Custom JSON', baseUrl: 'https://llm.example.com', model: 'my-model', auth: 'bearer' },
  };

  const DEFAULTS = {
    provider: 'openai', baseUrl: '', model: '', apiVersion: '2024-10-21', auth: '',
    prompts: [], system: '', maxTokens: 256, stream: true, temperature: '',
    // custom provider
    path: '/generate', bodyTemplate: '{"model": "{{model}}", "prompt": "{{prompt}}", "max_tokens": {{max_tokens}}}',
    textPath: 'text', inputTokensPath: 'usage.input_tokens', outputTokensPath: 'usage.output_tokens', authHeader: 'Authorization',
    // load
    loadModel: 'vus', vus: 10, rampUp: '1m', hold: '3m', rampDown: '30s', thinkTime: 2,
    rpm: 60, preAllocatedVUs: 0, maxVUs: 0, expectedLatency: 10,
    timeout: '120s', retry429: true, maxRetries: 3,
    // budgets (empty = no threshold)
    ttftP95: 2000, latencyP95: 20000, minTokensPerSec: 20, max429Pct: 1, maxErrorPct: 1,
    // prices in US$ per 1M tokens (0 = no cost estimate)
    priceIn: 0, priceOut: 0,
  };

  const EXAMPLE_PROMPTS = [
    'Summarise the return policy for an online shoe store in three bullet points.',
    'A customer says their order #4821 arrived damaged. Write a short, friendly reply.',
    'Explain the difference between a load test and a stress test to a product manager.',
    'Write a SQL query that returns the ten customers with the highest total order value.',
    'Give me five subject lines for a Black Friday sale email for a coffee roaster.',
  ];

  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const isDuration = (s) => /^\s*\d+(\.\d+)?(ms|s|m|h)(\d+(\.\d+)?(ms|s|m|h))*\s*$/.test(String(s));
  const blank = (v) => v === '' || v === null || v === undefined;
  const q = (s) => JSON.stringify(String(s));

  function cleanPrompts(p) {
    const list = Array.isArray(p) ? p : String(p || '').split(/\n\s*\n|\n(?=\s*[-*•]\s)|\n/);
    return list.map(s => String(s).replace(/^\s*[-*•]\s+/, '').trim()).filter(Boolean);
  }

  function durationSeconds(s) {
    let t = 0;
    String(s).replace(/(\d+(?:\.\d+)?)(ms|s|m|h)/g, (_, n, u) => { t += n * ({ ms: 0.001, s: 1, m: 60, h: 3600 })[u]; });
    return t;
  }

  function generate(input) {
    const o = Object.assign({}, DEFAULTS, input || {});
    const P = PROVIDERS[o.provider] ? o.provider : 'openai';
    const prov = PROVIDERS[P];
    const warnings = [], info = [];
    const baseUrl = String(o.baseUrl || prov.baseUrl).trim().replace(/\/+$/, '');
    const model = String(o.model || prov.model).trim();
    let auth = o.auth || prov.auth;
    if (P === 'custom') auth = String(o.authHeader || 'Authorization').trim().toLowerCase() === 'authorization' ? 'bearer' : 'custom';
    const prompts = cleanPrompts(o.prompts);
    if (!prompts.length) return { error: 'Add at least one prompt. Use a few different ones so the test is not one cached answer.' };
    if (prompts.length < 3) warnings.push('Only ' + prompts.length + ' prompt(s). Real traffic varies: with very few prompts, provider-side prompt caching can make results look better than production.');
    const maxTokens = Math.max(1, Math.round(num(o.maxTokens, 256)));
    const stream = !!o.stream;
    const timeout = isDuration(o.timeout) ? String(o.timeout).trim() : '120s';

    for (const k of ['rampUp', 'hold', 'rampDown']) if (!isDuration(o[k])) return { error: 'Durations should look like 30s, 5m or 1h30m (check "' + k + '").' };

    let customPath = '', bodyTemplate = '';
    if (P === 'custom') {
      customPath = String(o.path || '').trim();
      bodyTemplate = String(o.bodyTemplate || '').trim();
      if (!bodyTemplate.includes('{{prompt}}')) return { error: 'The body template needs a {{prompt}} placeholder where the prompt goes.' };
      try { JSON.parse(bodyTemplate.replace(/\{\{max_tokens\}\}/g, '1').replace(/\{\{(prompt|model)\}\}/g, 'x')); }
      catch (e) { return { error: 'The body template is not valid JSON once the placeholders are filled in: ' + e.message }; }
      if (!o.textPath) warnings.push('No text path: tokens can only be read from the usage paths.');
    }
    if (/YOUR-/.test(baseUrl) || /YOUR-/.test(model)) warnings.push('Replace the YOUR-… placeholders with your Azure resource and deployment names (or pass BASE_URL and MODEL with -e).');
    if (P === 'openai' && /localhost|127\.0\.0\.1|:11434/.test(baseUrl)) info.push('Local server (vLLM / Ollama): leave LLM_API_KEY empty if it needs no key. The script only sends the key when it is set.');

    // ---------------------------------------------------------------- load model
    let scenario;
    let vus = Math.max(1, Math.round(num(o.vus, 10)));
    if (o.loadModel === 'rate') {
      const rpm = Math.max(1, Math.round(num(o.rpm, 60)));
      const lat = Math.max(1, num(o.expectedLatency, 10));
      const needed = Math.ceil(rpm / 60 * lat);          // Little's law: in-flight requests = rate × time in system
      const pre = Math.max(1, Math.round(num(o.preAllocatedVUs, 0)) || Math.ceil(needed * 1.2));
      const max = Math.max(pre, Math.round(num(o.maxVUs, 0)) || Math.ceil(needed * 3));
      scenario = [
        "    llm: {",
        "      executor: 'ramping-arrival-rate',",
        "      startRate: 0,",
        "      timeUnit: '1m', // rates are requests per minute, the unit LLM providers use for limits",
        "      preAllocatedVUs: " + pre + ",",
        "      maxVUs: " + max + ", // each VU waits for a whole answer, so slow answers need many VUs: rate × latency",
        "      stages: [",
        "        { duration: " + q(o.rampUp) + ", target: " + rpm + " },",
        "        { duration: " + q(o.hold) + ", target: " + rpm + " },",
        "        { duration: " + q(o.rampDown) + ", target: 0 },",
        "      ],",
        "    },",
      ];
      info.push('Arrival rate: ' + rpm + ' requests a minute. At about ' + lat + ' s an answer that is about ' + needed + ' requests in flight at once (Little\'s law), so the script allows up to ' + max + ' VUs. If k6 warns about "insufficient VUs", the API is slower than you expected: raise maxVUs.');
      vus = max;
    } else {
      scenario = [
        "    llm: {",
        "      executor: 'ramping-vus',",
        "      startVUs: 0,",
        "      stages: [",
        "        { duration: " + q(o.rampUp) + ", target: " + vus + " },",
        "        { duration: " + q(o.hold) + ", target: " + vus + " },",
        "        { duration: " + q(o.rampDown) + ", target: 0 },",
        "      ],",
        "      gracefulRampDown: " + q(timeout) + ", // let in-flight answers finish",
        "    },",
      ];
      info.push('Virtual users: ' + vus + ' simulated people, each sending a prompt, waiting for the whole answer, then pausing ' + num(o.thinkTime, 0) + ' s. Use arrival rate instead if you have a target in requests a minute.');
    }

    // ---------------------------------------------------------------- thresholds
    const th = [];
    if (!blank(o.ttftP95) && stream) th.push("    llm_ttft: ['p(95)<" + num(o.ttftP95, 2000) + "'],");
    if (!blank(o.ttftP95) && !stream) info.push('Streaming is off, so the first byte only arrives with the whole answer: the TTFT budget is skipped. Turn streaming on to measure time to first token.');
    if (!blank(o.latencyP95)) th.push("    llm_latency: ['p(95)<" + num(o.latencyP95, 20000) + "'],");
    if (!blank(o.minTokensPerSec) && num(o.minTokensPerSec, 0) > 0) th.push("    llm_output_tokens_per_s: ['p(10)>=" + num(o.minTokensPerSec, 20) + "'], // 90% of answers at least this fast");
    if (!blank(o.max429Pct)) th.push("    llm_rate_limited: ['rate<" + +(num(o.max429Pct, 1) / 100).toFixed(4) + "'],");
    if (!blank(o.maxErrorPct)) th.push("    llm_errors: ['rate<" + +(num(o.maxErrorPct, 1) / 100).toFixed(4) + "'],");
    th.push("    checks: ['rate>0.99'],");

    // ---------------------------------------------------------------- request building
    let url, headers, body, parse;
    const keyLine = "  if (API_KEY) headers[" + q(auth === 'bearer' ? 'Authorization' : auth === 'custom' ? String(o.authHeader).trim() : auth) + "] = " + (auth === 'bearer' ? "'Bearer ' + API_KEY" : 'API_KEY') + ";";
    if (P === 'anthropic') {
      url = "BASE_URL + '/v1/messages'";
      headers = ["  const headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };", keyLine];
      body = [
        "  const body = { model: MODEL, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: prompt }] };",
        o.system ? "  body.system = SYSTEM;" : null,
        !blank(o.temperature) ? "  body.temperature = " + num(o.temperature, 1) + ";" : null,
        stream ? "  body.stream = true;" : null,
      ];
      parse = stream ? 'parseAnthropicStream' : 'parseAnthropic';
    } else if (P === 'custom') {
      url = "BASE_URL + " + q(customPath.startsWith('/') || !customPath ? customPath : '/' + customPath);
      headers = ["  const headers = { 'Content-Type': 'application/json' };", keyLine];
      body = ["  const body = fill(BODY_TEMPLATE, prompt);"];
      parse = stream ? 'parseCustomStream' : 'parseCustom';
    } else {
      url = P === 'azure'
        ? "BASE_URL + '/openai/deployments/' + MODEL + '/chat/completions?api-version=' + API_VERSION"
        : "BASE_URL + '/chat/completions'";
      headers = ["  const headers = { 'Content-Type': 'application/json' };", keyLine];
      body = [
        "  const messages = SYSTEM ? [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }] : [{ role: 'user', content: prompt }];",
        P === 'azure' ? "  const body = { messages, max_tokens: MAX_TOKENS };" : "  const body = { model: MODEL, messages, max_tokens: MAX_TOKENS };",
        !blank(o.temperature) ? "  body.temperature = " + num(o.temperature, 1) + ";" : null,
        stream ? "  body.stream = true;\n  body.stream_options = { include_usage: true }; // ask for token counts in the last chunk" : null,
      ];
      parse = stream ? 'parseOpenAIStream' : 'parseOpenAI';
    }

    // ---------------------------------------------------------------- script
    const L = [];
    const push = (...a) => a.forEach(x => { if (x !== null && x !== undefined) L.push(x); });
    push(
      "// k6 load test for an LLM endpoint (" + prov.label + "), made with https://pawansinha.com.au/tools/llm-load-test/",
      "//",
      "// Run:  k6 run -e LLM_API_KEY=... script.js",
      "// Optional: -e BASE_URL=... -e MODEL=...  (override the values below without editing the script)",
      "//",
      "// ⚠️ Every request is a real, billed model call. Start with a 1-VU smoke run, check your provider's rate limits and",
      "//    spending cap, and load test a key that is separate from production so you don't throttle real users.",
      "//",
      "// About TTFT: k6's HTTP client waits for the whole response, so it can't see tokens as they stream. llm_ttft uses",
      "// timings.waiting (time to first byte). With streaming on, providers usually send the first byte with the first",
      "// token, so this is a close approximation. A proxy or gateway that sends headers early makes it look faster.",
      "import http from 'k6/http';",
      "import { check, sleep } from 'k6';",
      "import exec from 'k6/execution';",
      "import { Trend, Rate, Counter } from 'k6/metrics';",
      "import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';",
      "",
      "const BASE_URL = (__ENV.BASE_URL || " + q(baseUrl) + ").replace(/\\/+$/, '');",
      "const MODEL = __ENV.MODEL || " + q(model) + ";",
      "const API_KEY = __ENV.LLM_API_KEY || '';",
      P === 'azure' ? "const API_VERSION = __ENV.API_VERSION || " + q(o.apiVersion || '2024-10-21') + ";" : null,
      "const MAX_TOKENS = " + maxTokens + ";",
      "const SYSTEM = " + q(o.system || '') + ";",
      P === 'custom' ? "const BODY_TEMPLATE = " + q(bodyTemplate) + ";" : null,
      P === 'custom' ? "const TEXT_PATH = " + q(o.textPath || '') + ";" : null,
      P === 'custom' ? "const INPUT_TOKENS_PATH = " + q(o.inputTokensPath || '') + ";" : null,
      P === 'custom' ? "const OUTPUT_TOKENS_PATH = " + q(o.outputTokensPath || '') + ";" : null,
      "const RETRY_429 = " + (o.retry429 ? 'true' : 'false') + ";",
      "const MAX_RETRIES = " + Math.max(0, Math.round(num(o.maxRetries, 3))) + ";",
      "const THINK_TIME = " + (o.loadModel === 'rate' ? 0 : Math.max(0, num(o.thinkTime, 0))) + "; // seconds between prompts" + (o.loadModel === 'rate' ? " (arrival rate sets the pace)" : ''),
      "const PRICE_IN = " + Math.max(0, num(o.priceIn, 0)) + ";  // US$ per 1M input tokens (0 = no cost estimate)",
      "const PRICE_OUT = " + Math.max(0, num(o.priceOut, 0)) + "; // US$ per 1M output tokens",
      "",
      "// Prompts are cycled so the test isn't one cached answer. Replace them with real ones from your logs.",
      "const PROMPTS = [",
      ...prompts.map(p => "  " + q(p) + ","),
      "];",
      "",
      "const ttft = new Trend('llm_ttft', true);",
      "const latency = new Trend('llm_latency', true);",
      "const tokensPerSec = new Trend('llm_output_tokens_per_s');",
      "const inputTokens = new Counter('llm_input_tokens');",
      "const outputTokens = new Counter('llm_output_tokens');",
      "const estimated = new Counter('llm_tokens_estimated');",
      "const rateLimited = new Rate('llm_rate_limited');",
      "const errors = new Rate('llm_errors');",
      "const retries = new Counter('llm_retries');",
      "const answers = new Counter('llm_answers');",
      "let warned = 0; // log the first few failures per VU, not thousands",
      "",
      "export const options = {",
      "  scenarios: {",
      ...scenario,
      "  },",
      "  thresholds: {",
      ...th,
      "  },",
      "};",
      "",
      "export function setup() {",
      "  if (!API_KEY && !/localhost|127\\.0\\.0\\.1/.test(BASE_URL)) console.warn('LLM_API_KEY is not set. Run: k6 run -e LLM_API_KEY=... script.js');",
      "}",
      "",
      "export default function () {",
      "  const prompt = PROMPTS[exec.scenario.iterationInTest % PROMPTS.length];",
      ...headers,
      ...body.filter(x => x !== null),
      "  const params = { headers, timeout: " + q(timeout) + ", tags: { name: 'llm' } };",
      "",
      "  let res;",
      "  for (let attempt = 0; ; attempt++) {",
      "    res = http.post(" + url + ", JSON.stringify(body), params);",
      "    rateLimited.add(res.status === 429);",
      "    if (res.status !== 429 || !RETRY_429 || attempt >= MAX_RETRIES) break;",
      "    retries.add(1);",
      "    sleep(backoff(res, attempt)); // honour Retry-After, like a well-behaved client would",
      "  }",
      "",
      "  const ok = res.status >= 200 && res.status < 300;",
      "  const r = ok ? " + parse + "(res.body || '') : { text: '', error: true };",
      "  const good = ok && !r.error && r.text.length > 0;",
      "  errors.add(!good);",
      "  check(res, {",
      "    'status is 2xx': () => ok,",
      "    'answer is not empty': () => good,",
      "  });",
      "  if (!good) {",
      "    if (res.status !== 429 && warned++ < 3) console.warn('Request failed: HTTP ' + res.status + ' ' + String(res.body || res.error || '').slice(0, 200));",
      "    sleep(THINK_TIME);",
      "    return;",
      "  }",
      "",
      "  const total = res.timings.duration; // ms, sending to last byte",
      stream ? "  const first = res.timings.waiting; // ms, time to first byte ≈ time to first token (see note at the top)" : null,
      stream ? "  ttft.add(first);" : null,
      "  latency.add(total);",
      "  answers.add(1);",
      "",
      "  let tin = r.inputTokens, tout = r.outputTokens;",
      "  if (!tout) { tout = Math.ceil(r.text.length / 4); estimated.add(1); } // no usage block: about 4 characters a token",
      "  if (!tin) tin = Math.ceil((SYSTEM.length + prompt.length) / 4);",
      "  inputTokens.add(tin);",
      "  outputTokens.add(tout);",
      stream
        ? "  const genMs = total - first; // time spent streaming tokens after the first one\n  if (genMs > 0 && tout > 1) tokensPerSec.add((tout - 1) / (genMs / 1000));"
        : "  if (total > 0) tokensPerSec.add(tout / (total / 1000)); // end-to-end: includes the wait before the first token",
      "",
      "  sleep(THINK_TIME);",
      "}",
      "",
      "function backoff(res, attempt) {",
      "  const ra = Number(res.headers['Retry-After'] || res.headers['retry-after']);",
      "  const base = Number.isFinite(ra) && ra >= 0 ? ra : Math.pow(2, attempt);",
      "  return Math.min(base, 60) + Math.random(); // jitter so VUs don't retry in lock-step",
      "}",
      ""
    );

    // response parsers, only the one needed
    const parsers = {
      parseOpenAI: [
        "function parseOpenAI(text) {",
        "  let j;",
        "  try { j = JSON.parse(text); } catch (e) { return { text: '', error: true }; }",
        "  const c = j.choices && j.choices[0];",
        "  const u = j.usage || {};",
        "  return { text: (c && c.message && c.message.content) || '', inputTokens: u.prompt_tokens || 0, outputTokens: u.completion_tokens || 0, error: !!j.error };",
        "}",
      ],
      parseOpenAIStream: [
        "// Server-sent events: 'data: {json}' lines, ending with 'data: [DONE]'. The last chunk carries usage when",
        "// stream_options.include_usage is supported. Some OpenAI-compatible servers ignore it: tokens are then estimated.",
        "function parseOpenAIStream(text) {",
        "  const out = { text: '', inputTokens: 0, outputTokens: 0, error: false };",
        "  for (const line of text.split('\\n')) {",
        "    if (!line.startsWith('data:')) continue;",
        "    const data = line.slice(5).trim();",
        "    if (!data || data === '[DONE]') continue;",
        "    let j;",
        "    try { j = JSON.parse(data); } catch (e) { continue; }",
        "    if (j.error) out.error = true;",
        "    const d = j.choices && j.choices[0] && j.choices[0].delta;",
        "    if (d && d.content) out.text += d.content;",
        "    if (j.usage) { out.inputTokens = j.usage.prompt_tokens || 0; out.outputTokens = j.usage.completion_tokens || 0; }",
        "  }",
        "  return out;",
        "}",
      ],
      parseAnthropic: [
        "function parseAnthropic(text) {",
        "  let j;",
        "  try { j = JSON.parse(text); } catch (e) { return { text: '', error: true }; }",
        "  const parts = (j.content || []).filter(c => c.type === 'text').map(c => c.text);",
        "  const u = j.usage || {};",
        "  return { text: parts.join(''), inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0, error: j.type === 'error' };",
        "}",
      ],
      parseAnthropicStream: [
        "// Server-sent events: message_start has the input tokens, content_block_delta the text, message_delta the output tokens.",
        "function parseAnthropicStream(text) {",
        "  const out = { text: '', inputTokens: 0, outputTokens: 0, error: false };",
        "  for (const line of text.split('\\n')) {",
        "    if (!line.startsWith('data:')) continue;",
        "    let j;",
        "    try { j = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }",
        "    if (j.type === 'error') out.error = true;",
        "    if (j.type === 'message_start' && j.message && j.message.usage) out.inputTokens = j.message.usage.input_tokens || 0;",
        "    if (j.type === 'content_block_delta' && j.delta && j.delta.text) out.text += j.delta.text;",
        "    if (j.type === 'message_delta' && j.usage) out.outputTokens = j.usage.output_tokens || out.outputTokens;",
        "  }",
        "  return out;",
        "}",
      ],
      parseCustom: [
        "function parseCustom(text) {",
        "  let j;",
        "  try { j = JSON.parse(text); } catch (e) { return { text: '', error: true }; }",
        "  return { text: String(pick(j, TEXT_PATH) || ''), inputTokens: Number(pick(j, INPUT_TOKENS_PATH)) || 0, outputTokens: Number(pick(j, OUTPUT_TOKENS_PATH)) || 0, error: false };",
        "}",
      ],
      parseCustomStream: [
        "// Server-sent events with one JSON object per 'data:' line: the text path is read from every chunk and joined,",
        "// the token paths from the last chunk that has them.",
        "function parseCustomStream(text) {",
        "  if (!/^data:/m.test(text)) return parseCustom(text); // the server answered with plain JSON instead",
        "  const out = { text: '', inputTokens: 0, outputTokens: 0, error: false };",
        "  for (const line of text.split('\\n')) {",
        "    if (!line.startsWith('data:')) continue;",
        "    let j;",
        "    try { j = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }",
        "    const t = pick(j, TEXT_PATH);",
        "    if (t) out.text += t;",
        "    out.inputTokens = Number(pick(j, INPUT_TOKENS_PATH)) || out.inputTokens;",
        "    out.outputTokens = Number(pick(j, OUTPUT_TOKENS_PATH)) || out.outputTokens;",
        "  }",
        "  return out;",
        "}",
      ],
    };
    push(...parsers[parse], "");
    if (parse === 'parseCustomStream') push(...parsers.parseCustom, "");
    if (P === 'custom') push(
      "function pick(obj, path) {",
      "  if (!path) return undefined;",
      "  return path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[/^\\d+$/.test(k) ? Number(k) : k]), obj);",
      "}",
      "",
      "function fill(template, prompt) {",
      "  const esc = (s) => JSON.stringify(String(s)).slice(1, -1); // safe inside a JSON string",
      "  return JSON.parse(template.replace(/\\{\\{prompt\\}\\}/g, esc(prompt)).replace(/\\{\\{model\\}\\}/g, esc(MODEL)).replace(/\\{\\{max_tokens\\}\\}/g, String(MAX_TOKENS)));",
      "}",
      ""
    );

    push(
      "// Adds token totals and a cost estimate under k6's usual end-of-test summary.",
      "export function handleSummary(data) {",
      "  const m = (name, key) => (data.metrics[name] && data.metrics[name].values[key]) || 0;",
      "  const reqs = m('llm_answers', 'count');",
      "  const tin = m('llm_input_tokens', 'count'), tout = m('llm_output_tokens', 'count');",
      "  const lines = ['', '  LLM summary', '  -----------',",
      "    '  successful answers ....: ' + reqs,",
      "    '  input tokens ..........: ' + tin + (reqs ? ' (' + Math.round(tin / reqs) + ' per request)' : ''),",
      "    '  output tokens .........: ' + tout + (reqs ? ' (' + Math.round(tout / reqs) + ' per request)' : ''),",
      "    '  answered with 429 .....: ' + (m('llm_rate_limited', 'rate') * 100).toFixed(2) + '% of attempts, ' + m('llm_retries', 'count') + ' retries'];",
      "  if (m('llm_tokens_estimated', 'count')) lines.push('  ⚠️ ' + m('llm_tokens_estimated', 'count') + ' answers had no usage block: their output tokens are estimated (4 characters a token).');",
      "  if (PRICE_IN || PRICE_OUT) {",
      "    const cost = tin / 1e6 * PRICE_IN + tout / 1e6 * PRICE_OUT;",
      "    lines.push('  cost of this test ......: US$' + cost.toFixed(4));",
      "    if (reqs) lines.push('  cost per 1,000 answers .: US$' + (cost / reqs * 1000).toFixed(2) + '  (list price, before caching or batch discounts)');",
      "  }",
      "  return { stdout: textSummary(data, { indent: ' ', enableColors: true }) + '\\n' + lines.join('\\n') + '\\n' };",
      "}",
      ""
    );

    if (stream && P === 'custom') {
      info.push('Custom streaming: the script reads one JSON object per "data:" line and joins the text path from each chunk. If the server answers with plain JSON instead, it reads that.');
      if (!/stream/i.test(bodyTemplate)) warnings.push('Streaming is on, but the body template has no "stream" field. Add whatever your API needs to stream (for example "stream": true), or TTFT will equal the full response time.');
    }
    if (!(num(o.priceIn, 0) || num(o.priceOut, 0))) info.push('Add your model\'s price per 1M tokens to get a cost estimate at the end of the run.');
    const est = o.loadModel === 'rate'
      ? Math.round(num(o.rpm, 60) * (durationSeconds(o.rampUp) / 2 + durationSeconds(o.hold) + durationSeconds(o.rampDown) / 2) / 60)
      : null;
    if (est) {
      const cost = (num(o.priceIn, 0) * 300 + num(o.priceOut, 0) * maxTokens) * est / 1e6;
      info.push('This run sends about ' + est.toLocaleString('en-AU') + ' requests' + (cost ? ', roughly US$' + cost.toFixed(2) + ' at list price if prompts are ~300 tokens and answers use the full ' + maxTokens + ' tokens' : '') + '.');
    }

    return { script: L.join('\n'), warnings, info, env: [{ name: 'LLM_API_KEY', secret: true }], vus };
  }

  const api = { generate, PROVIDERS, DEFAULTS, EXAMPLE_PROMPTS, cleanPrompts };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LlmToK6 = api;
})(typeof window !== 'undefined' ? window : this);
