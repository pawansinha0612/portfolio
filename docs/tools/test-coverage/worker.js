/* Web Worker for /tools/test-coverage/: parses and analyses big coverage reports off the main thread. Nothing leaves the browser. */
/* global importScripts, CoverageIntel */
importScripts('/tools/ci-failure-detective/ci.js', '/tools/test-coverage/coverage.js');
self.onmessage = function (e) {
  try { self.postMessage({ ok: true, result: CoverageIntel.analyse(e.data) }); }
  catch (err) { self.postMessage({ ok: false, error: err && err.message ? err.message : String(err) }); }
};
