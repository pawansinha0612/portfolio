/* Web Worker: reads a JMeter results file in chunks and analyses it off the main thread.
   The file never leaves the browser: it is read with File.slice() and parsed here (see jtl.js). */
importScripts('/tools/jtl-analyser/jtl.js');

self.onmessage = async (e) => {
  const { file, opts } = e.data;
  try {
    const result = await JTL.analyseFile(file, opts, (done, rows) => self.postMessage({ type: 'progress', done, rows }));
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
