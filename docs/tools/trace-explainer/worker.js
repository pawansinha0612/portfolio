/* Web Worker for /tools/trace-explainer/: reads trace files, parses and analyses them off the main thread so big
   exports (thousands of traces) never freeze the page. The files never leave the browser. */
importScripts('/tools/trace-explainer/trace.js');

const session = TraceExplainer.createSession();

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.type === 'load') {
      const texts = [];
      for (let k = 0; k < m.inputs.length; k++) {
        const x = m.inputs[k];
        self.postMessage({ type: 'progress', text: 'Reading ' + (x.name || 'pasted text') + '…', frac: m.inputs.length > 1 ? k / m.inputs.length : null });
        texts.push({ name: x.name, text: x.file ? await x.file.text() : x.text });
      }
      self.postMessage({ type: 'progress', text: 'Parsing spans…', frac: null });
      const r = session.load(texts, m.opts, (done, total) => self.postMessage({ type: 'progress', text: 'Analysed ' + done + ' of ' + total + ' traces…', frac: done / total }));
      self.postMessage({ type: 'done', result: r });
    } else if (m.type === 'trace') {
      self.postMessage({ type: 'trace', single: session.trace(m.id) });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
