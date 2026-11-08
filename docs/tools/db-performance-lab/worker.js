/* Web Worker for /tools/db-performance-lab/: parses and analyses big plans and statistics files off the main thread.
   Nothing leaves the browser. */
importScripts('/tools/db-performance-lab/dbplan.js');

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    const text = m.file ? await m.file.text() : m.text;
    self.postMessage({ type: 'done', result: DBPlanLab.analyse(text, m.opts || {}) });
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
