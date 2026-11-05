#!/usr/bin/env node
// Copies the converters from the website (docs/tools/*/convert.js) into lib/, so the site and the CLI share one source.
// Runs before every `npm pack` / `npm publish` (prepack) and before the tests.
'use strict';
const fs = require('fs');
const path = require('path');
const tools = path.join(__dirname, '..', '..', '..', 'docs', 'tools');
const lib = path.join(__dirname, '..', 'lib');
fs.mkdirSync(lib, { recursive: true });
for (const name of ['jmeter', 'postman', 'openapi', 'curl']) {
  const src = path.join(tools, name + '-to-k6', 'convert.js');
  if (!fs.existsSync(src)) throw new Error('Missing ' + src + ' (run from the portfolio repo)');
  fs.copyFileSync(src, path.join(lib, name + '.js'));
}
console.error('to-k6: copied 4 converters into lib/');
