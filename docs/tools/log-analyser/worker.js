/* Web Worker for /tools/log-analyser/: reads a log in 4 MB chunks (File.slice) or takes pasted text, streams it
   through logs.js and posts progress. The file never leaves the browser. */
importScripts('/tools/log-analyser/logs.js');

self.onmessage = async (e) => {
  const { file, text, opts } = e.data || {};
  try {
    const a = LogAnalyser.createAnalyser(opts || {});
    const CH = 4 * 1024 * 1024;
    if (file) {
      const dec = new TextDecoder('utf-8');
      for (let off = 0; off < file.size; off += CH) {
        const buf = await file.slice(off, off + CH).arrayBuffer();
        a.push(dec.decode(buf, { stream: off + CH < file.size }));
        self.postMessage({ type: 'progress', done: Math.min(file.size, off + CH), total: file.size, lines: a.lines });
      }
    } else {
      const s = String(text || '');
      for (let i = 0; i < s.length; i += CH) {
        a.push(s.slice(i, i + CH));
        self.postMessage({ type: 'progress', done: Math.min(s.length, i + CH), total: s.length, lines: a.lines });
      }
    }
    self.postMessage({ type: 'done', result: a.end() });
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
